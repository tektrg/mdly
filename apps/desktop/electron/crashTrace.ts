import fsSync from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import { app, type BrowserWindow } from "electron";

// Always-on, low-overhead memory tracer for diagnosing the background OOM
// crash (renderer *and* main-process V8 aborts observed in the wild). It
// writes newline-delimited JSON to a file under userData/logs, flushed
// synchronously so the last record before a hard abort is on disk — the app
// crashes while backgrounded, so console output is unrecoverable.
//
// The renderer is sandboxed (no nodeIntegration), so its true V8 heap is read
// via webContents.debugger (silent CDP; no DevTools banner). `ps`/working-set
// under-reports Chromium ~80×, so JSHeapUsedSize from CDP is the reliable
// signal; working-set is kept only as a cross-check.
//
// Disable with HUBBLE_DESKTOP_DISABLE_CRASH_TRACE=1.

const SAMPLE_INTERVAL_MS = 20_000;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const CDP_PROTOCOL_VERSION = "1.3";
const RENDERER_METRIC_NAMES = new Set([
	"JSHeapUsedSize",
	"JSHeapTotalSize",
	"Nodes",
	"Documents",
	"JSEventListeners",
	"LayoutObjects",
]);

// When the renderer JS heap crosses this size, dump a one-time V8 heap snapshot
// so the exact retained object class can be named in DevTools. The traced crash
// filled to ~3992 MB against a 4096 MB V8 cap; 2500 MB leaves ~1.6 GB of
// headroom for V8 to serialize the snapshot without itself OOMing, while the
// leak is already dominant enough to stand out in the class histogram.
const DEFAULT_HEAP_SNAPSHOT_THRESHOLD_MB = 2500;

let cachedLogPath: string | null = null;
let childProcessListenerAttached = false;
let heapSnapshotCaptured = false;
let heapSnapshotInProgress = false;

function isDisabled(): boolean {
	return process.env.HUBBLE_DESKTOP_DISABLE_CRASH_TRACE === "1";
}

// Overridable via env for verification (set low to force an early capture).
function heapSnapshotThresholdMb(): number {
	const raw = Number(process.env.HUBBLE_DESKTOP_HEAP_SNAPSHOT_MB);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HEAP_SNAPSHOT_THRESHOLD_MB;
}

function toMb(bytes: number | undefined): number | null {
	if (typeof bytes !== "number") return null;
	return Math.round((bytes / 1048576) * 10) / 10;
}

function logPath(): string {
	if (cachedLogPath) return cachedLogPath;
	const dir = path.join(app.getPath("userData"), "logs");
	fsSync.mkdirSync(dir, { recursive: true });
	cachedLogPath = path.join(dir, "crash-trace.log");
	return cachedLogPath;
}

// Keep disk bounded: once the log passes the cap, roll it to a single `.1`
// backup (overwriting any previous backup) and start fresh.
function rotateIfNeeded(filePath: string): void {
	try {
		if (fsSync.statSync(filePath).size > MAX_LOG_BYTES) {
			fsSync.renameSync(filePath, `${filePath}.1`);
		}
	} catch {
		// No log file yet — nothing to rotate.
	}
}

function writeRecord(record: Record<string, unknown>): void {
	try {
		const filePath = logPath();
		rotateIfNeeded(filePath);
		fsSync.appendFileSync(filePath, `${JSON.stringify(record)}\n`);
	} catch {
		// Tracing must never take down the app it is observing.
	}
}

export function recordCrashTraceEvent(
	event: string,
	data?: Record<string, unknown>,
): void {
	if (isDisabled()) return;
	writeRecord({
		t: new Date().toISOString(),
		kind: "event",
		event,
		uptimeSec: Math.round(process.uptime()),
		...data,
	});
}

// Main process is Node/V8: process.memoryUsage() plus v8 heap statistics.
// detachedContexts is a canonical JS-leak tell, so it is surfaced explicitly.
function readMainProcessMetrics(): Record<string, number> {
	const memory = process.memoryUsage();
	const heap = v8.getHeapStatistics();
	return {
		rss: memory.rss,
		heapUsed: memory.heapUsed,
		heapTotal: memory.heapTotal,
		external: memory.external,
		arrayBuffers: memory.arrayBuffers,
		v8UsedHeap: heap.used_heap_size,
		v8TotalHeap: heap.total_heap_size,
		v8HeapLimit: heap.heap_size_limit,
		v8MallocedMemory: heap.malloced_memory,
		nativeContexts: heap.number_of_native_contexts,
		detachedContexts: heap.number_of_detached_contexts,
	};
}

// Compact per-process working-set snapshot; catches GPU/utility bloat that the
// V8-heap readings would miss.
function readProcessMetricsSummary(): Array<Record<string, number | string>> {
	return app.getAppMetrics().map((metric) => ({
		type: metric.type,
		pid: metric.pid,
		workingSetKb: metric.memory.workingSetSize,
		peakWorkingSetKb: metric.memory.peakWorkingSetSize,
	}));
}

function ensureDebuggerAttached(window: BrowserWindow): boolean {
	const remoteDebugger = window.webContents.debugger;
	if (remoteDebugger.isAttached()) return true;
	try {
		remoteDebugger.attach(CDP_PROTOCOL_VERSION);
		void remoteDebugger.sendCommand("Performance.enable");
		return true;
	} catch (error) {
		recordCrashTraceEvent("debugger-attach-failed", { message: String(error) });
		return false;
	}
}

async function readRendererMetrics(
	window: BrowserWindow,
): Promise<Record<string, number> | null> {
	const remoteDebugger = window.webContents.debugger;
	if (!remoteDebugger.isAttached()) return null;
	try {
		const result = (await remoteDebugger.sendCommand(
			"Performance.getMetrics",
		)) as { metrics: Array<{ name: string; value: number }> };
		const metrics: Record<string, number> = {};
		for (const metric of result.metrics) {
			if (RENDERER_METRIC_NAMES.has(metric.name)) {
				metrics[metric.name] = metric.value;
			}
		}
		return metrics;
	} catch {
		return null;
	}
}

function heapSnapshotPath(): string {
	const dir = path.join(app.getPath("userData"), "logs");
	fsSync.mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return path.join(dir, `renderer-${stamp}.heapsnapshot`);
}

// One-time renderer heap snapshot via CDP. V8 streams the snapshot as many
// `HeapProfiler.addHeapSnapshotChunk` notifications; we append each chunk to
// disk synchronously (rather than buffering the whole multi-hundred-MB
// snapshot in the main process) so a crash mid-capture still leaves a partial,
// and so the main process itself does not balloon. The resulting
// `.heapsnapshot` file loads directly in Chrome DevTools → Memory.
async function captureHeapSnapshot(
	window: BrowserWindow,
	rendererHeapMb: number,
): Promise<void> {
	if (heapSnapshotCaptured || heapSnapshotInProgress) return;
	if (window.isDestroyed() || window.webContents.isDestroyed()) return;
	const remoteDebugger = window.webContents.debugger;
	if (!remoteDebugger.isAttached()) return;

	heapSnapshotInProgress = true;
	const filePath = heapSnapshotPath();
	let fileDescriptor: number | null = null;
	let bytesWritten = 0;
	const onDebuggerMessage = (
		_event: unknown,
		method: string,
		params: { chunk?: string },
	): void => {
		if (
			method === "HeapProfiler.addHeapSnapshotChunk" &&
			typeof params.chunk === "string" &&
			fileDescriptor !== null
		) {
			fsSync.writeSync(fileDescriptor, params.chunk);
			bytesWritten += params.chunk.length;
		}
	};

	try {
		fileDescriptor = fsSync.openSync(filePath, "w");
		remoteDebugger.on("message", onDebuggerMessage);
		await remoteDebugger.sendCommand("HeapProfiler.enable");
		recordCrashTraceEvent("heap-snapshot-start", {
			thresholdMB: heapSnapshotThresholdMb(),
			rendererHeapMB: rendererHeapMb,
			file: filePath,
		});
		await remoteDebugger.sendCommand("HeapProfiler.takeHeapSnapshot", {
			reportProgress: false,
			captureNumericValue: false,
		});
		heapSnapshotCaptured = true;
		recordCrashTraceEvent("heap-snapshot-done", {
			file: filePath,
			bytes: bytesWritten,
		});
	} catch (error) {
		recordCrashTraceEvent("heap-snapshot-failed", { message: String(error) });
	} finally {
		remoteDebugger.off("message", onDebuggerMessage);
		if (fileDescriptor !== null) {
			try {
				fsSync.closeSync(fileDescriptor);
			} catch {
				// File already gone / never opened — nothing to close.
			}
		}
		heapSnapshotInProgress = false;
	}
}

async function sampleOnce(window: BrowserWindow): Promise<void> {
	if (window.isDestroyed()) return;
	ensureDebuggerAttached(window);
	const renderer = window.webContents.isDestroyed()
		? null
		: await readRendererMetrics(window);
	if (window.isDestroyed()) return;
	const main = readMainProcessMetrics();
	const rendererHeapMb = renderer ? toMb(renderer.JSHeapUsedSize) : null;
	writeRecord({
		t: new Date().toISOString(),
		kind: "sample",
		uptimeSec: Math.round(process.uptime()),
		// Headline numbers for at-a-glance scanning; raw bytes kept below.
		rendererJsHeapMB: rendererHeapMb,
		mainV8HeapMB: toMb(main.v8UsedHeap),
		renderer,
		main,
		procs: readProcessMetricsSummary(),
	});

	// Fire the diagnostic snapshot once the leak is large enough to dominate.
	if (
		!heapSnapshotCaptured &&
		!heapSnapshotInProgress &&
		rendererHeapMb !== null &&
		rendererHeapMb >= heapSnapshotThresholdMb()
	) {
		void captureHeapSnapshot(window, rendererHeapMb);
	}
}

export function crashTraceLogPath(): string {
	return logPath();
}

// Begin tracing for a window. Safe to call once per created window; the
// app-level child-process listener registers only once.
export function startCrashTrace(window: BrowserWindow): void {
	if (isDisabled()) return;
	recordCrashTraceEvent("session-start", {
		version: app.getVersion(),
		pid: process.pid,
		platform: process.platform,
	});

	const webContents = window.webContents;
	webContents.on("did-finish-load", () => {
		ensureDebuggerAttached(window);
	});
	webContents.on("render-process-gone", (_event, details) => {
		recordCrashTraceEvent("render-process-gone", { ...details });
	});
	webContents.on("unresponsive", () => {
		recordCrashTraceEvent("renderer-unresponsive");
	});
	webContents.on("responsive", () => {
		recordCrashTraceEvent("renderer-responsive");
	});

	const timer = setInterval(() => {
		void sampleOnce(window);
	}, SAMPLE_INTERVAL_MS);
	// Do not keep the event loop alive solely for sampling.
	timer.unref?.();
	window.on("closed", () => clearInterval(timer));

	if (!childProcessListenerAttached) {
		childProcessListenerAttached = true;
		app.on("child-process-gone", (_event, details) => {
			recordCrashTraceEvent("child-process-gone", { ...details });
		});
	}

	// First sample immediately so a fast crash still leaves a baseline.
	void sampleOnce(window);
}
