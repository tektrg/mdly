// Renderer-side runtime detector for the file-list store-write storm behind the
// background OOM crash.
//
// The captured 3.37 GB heap snapshot proved ~29.6M React update records
// accumulate on a *single* file-list-store subscription (commit starvation):
// something writes the file-list store in a tight loop, each write force-updates
// an on-screen subscriber, and React never commits so the update queue never
// drains — until the renderer hits its ~4 GB V8 ceiling. A heap snapshot records
// what exists but NOT the JS call stack driving the loop.
//
// This detector counts writes into the file-list store (and file scans that feed
// it) in a rolling window. When the rate crosses a clearly-abnormal threshold it
// captures the offending call stack once and forwards it to the main-process
// crash-trace log — the app crashes while backgrounded, so console output is
// unrecoverable.
//
// Cost in normal use is one integer compare + increment per store write; a stack
// is only captured when a storm actually fires. The whole module no-ops when the
// diagnostics bridge is absent (kill switch, or non-Electron test environment),
// so it is safe to leave wired until the loop trigger is fixed.

type DiagnosticsBridge = {
	reportStorm: (payload: Record<string, unknown>) => void;
};

declare global {
	interface Window {
		hubbleDiagnostics?: DiagnosticsBridge;
	}
}

// Tumbling window: O(1) per event, no unbounded buffer even if the loop fires
// hundreds of thousands of times before it yields.
const WINDOW_MS = 1000;
// Normal bursts (workspace open, window focus) fire a handful of writes; a storm
// sustains hundreds+ per second. 100 in a single window is unambiguously wrong.
const STORM_THRESHOLD = 100;
// Once a storm is reported for a label, wait before reporting it again so a
// sustained loop does not itself flood the log.
const REPORT_COOLDOWN_MS = 5000;

type LabelState = {
	windowStart: number;
	windowCount: number;
	lastReportedAt: number;
	totalSinceStart: number;
};

const states = new Map<string, LabelState>();

function isEnabled(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof window.hubbleDiagnostics?.reportStorm === "function"
	);
}

export function recordStormEvent(
	label: string,
	// Extra context captured ONLY when a storm actually fires (lazy so it costs
	// nothing on the hot path). E.g. the editor detector passes the storming
	// transaction's meta keys / step count, which name the offending plugin.
	detailFn?: () => Record<string, unknown>,
): void {
	if (!isEnabled()) return;
	const now = performance.now();

	let state = states.get(label);
	if (!state) {
		state = {
			windowStart: now,
			windowCount: 0,
			lastReportedAt: 0,
			totalSinceStart: 0,
		};
		states.set(label, state);
	}

	if (now - state.windowStart >= WINDOW_MS) {
		state.windowStart = now;
		state.windowCount = 0;
	}
	state.windowCount += 1;
	state.totalSinceStart += 1;

	// `===` fires exactly once as the window crosses the threshold, not on every
	// subsequent event; the cooldown limits reporting across windows.
	if (
		state.windowCount === STORM_THRESHOLD &&
		now - state.lastReportedAt >= REPORT_COOLDOWN_MS
	) {
		state.lastReportedAt = now;
		reportStorm(label, state, now, detailFn);
	}
}

function reportStorm(
	label: string,
	state: LabelState,
	now: number,
	detailFn?: () => Record<string, unknown>,
): void {
	// Capturing a stack is expensive, so it happens only when a storm fires.
	const stack = new Error(`storm:${label}`).stack ?? "";
	let detail: Record<string, unknown> | undefined;
	try {
		detail = detailFn?.();
	} catch {
		// A broken detail probe must not suppress the storm report itself.
	}
	try {
		window.hubbleDiagnostics?.reportStorm({
			label,
			countInWindow: state.windowCount,
			elapsedMs: Math.round(now - state.windowStart),
			totalSinceStart: state.totalSinceStart,
			...(detail ? { detail } : {}),
			stack,
		});
	} catch {
		// Diagnostics must never take down the app they observe.
	}
}
