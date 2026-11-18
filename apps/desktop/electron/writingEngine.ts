/**
 * The local writing engine behind "the dot": Apple's on-device model, run by a
 * small Swift helper (`native/writing-helper`, bundled at Contents/MacOS) kept
 * alive and spoken to with JSON lines over stdin/stdout.
 *
 * One status owner per engine: `status` moves idle → loading → ready, or to
 * `unavailable` (Apple Intelligence off, not eligible, model not ready,
 * unsupported language/OS — `reason` says which) / `failed` (helper missing,
 * crashed, timed out). Every failure is a visible state, never a hang:
 * starting and each run are bounded by timeouts.
 *
 * `createAppleEngine` is the real engine; `createFakeEngine` is for tests.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const HELPER_NAME = "mdly-writing-helper";

/** Why the on-device model can't run here; local tools then go to the agent. */
export type UnavailableReason =
	| "apple-intelligence-off"
	| "not-eligible"
	| "model-not-ready"
	| "unsupported-language"
	| "unsupported-os"
	| "unavailable";

export type EngineState =
	| "idle"
	| "loading"
	| "ready"
	| "unavailable"
	| "failed";

export interface EngineStatus {
	state: EngineState;
	reason?: UnavailableReason;
	error?: string;
}

export type EngineRunResult =
	| { status: "done"; text: string }
	| { status: "cancelled" }
	| { status: "unavailable"; reason: UnavailableReason; engine: EngineStatus }
	| { status: "failed"; error: string; engine: EngineStatus };

export interface WritingEngine {
	getStatus(): EngineStatus;
	/** Starts the helper and loads the model early (editor opened). Never throws. */
	prewarm(): Promise<void>;
	run(prompt: string, signal?: AbortSignal): Promise<EngineRunResult>;
	dispose(): Promise<void>;
}

const UNAVAILABLE_REASONS: readonly UnavailableReason[] = [
	"apple-intelligence-off",
	"not-eligible",
	"model-not-ready",
	"unsupported-language",
	"unsupported-os",
	"unavailable",
];

export function unavailableMessage(reason: UnavailableReason): string {
	switch (reason) {
		case "apple-intelligence-off":
			return "Apple Intelligence is off (System Settings › Apple Intelligence & Siri)";
		case "not-eligible":
			return "This Mac can't run Apple's on-device model";
		case "model-not-ready":
			return "Apple's on-device model is still downloading";
		case "unsupported-language":
			return "Apple's on-device model doesn't support this language";
		case "unsupported-os":
			return "Apple's on-device model needs macOS 26";
		default:
			return "Apple's on-device model is unavailable";
	}
}

/** Where the helper lives: Contents/MacOS in the packaged app, else the dev build. */
export function helperPath(
	resourcesDir: string | undefined,
	appDir: string,
	exists: (p: string) => boolean = existsSync,
): string {
	if (resourcesDir) {
		const bundled = path.join(resourcesDir, "..", "MacOS", HELPER_NAME);
		if (exists(bundled)) return bundled;
	}
	return path.join(appDir, "native", "build", HELPER_NAME);
}

export function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	what: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() =>
				reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)),
			ms,
		);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export interface FakeEngineOptions {
	respond?: (prompt: string) => string | Promise<string>;
	failWith?: string;
	unavailable?: UnavailableReason;
}

export function createFakeEngine(
	options: FakeEngineOptions = {},
): WritingEngine {
	let status: EngineStatus = { state: "idle" };
	return {
		getStatus: () => status,
		async prewarm() {},
		async run(prompt) {
			if (options.unavailable) {
				status = { state: "unavailable", reason: options.unavailable };
				return {
					status: "unavailable",
					reason: options.unavailable,
					engine: status,
				};
			}
			if (options.failWith) {
				status = { state: "failed", error: options.failWith };
				return { status: "failed", error: options.failWith, engine: status };
			}
			status = { state: "ready" };
			return {
				status: "done",
				text: await (options.respond ?? ((p) => p))(prompt),
			};
		},
		async dispose() {},
	};
}

/** The slice of a child process the engine uses (a fake stands in for tests). */
export interface HelperProcess {
	stdin: { write(line: string): unknown; end(): unknown };
	stdout: { on(event: "data", fn: (chunk: Buffer | string) => void): unknown };
	stderr?: {
		on(event: "data", fn: (chunk: Buffer | string) => void): unknown;
	};
	on(
		event: "exit" | "error",
		fn: (codeOrError: number | Error | null) => void,
	): unknown;
	kill(): unknown;
}

export interface AppleEngineOptions {
	helperPath: string;
	startTimeoutMs?: number;
	runTimeoutMs?: number;
	/** After a cancel/timeout, how long the helper gets to stop before it is killed. */
	stopGraceMs?: number;
	/** Injected for tests; defaults to `spawn(helperPath)`. */
	spawnHelper?: (helperPath: string) => HelperProcess;
}

type Reply = {
	id?: string;
	ok?: boolean;
	text?: string;
	code?: string;
	error?: string;
	availability?: string;
};

type Helper = {
	proc: HelperProcess;
	request(body: Record<string, unknown>): { id: string; reply: Promise<Reply> };
	alive(): boolean;
};

function isReason(value: unknown): value is UnavailableReason {
	return UNAVAILABLE_REASONS.includes(value as UnavailableReason);
}

/**
 * Lifecycle rules:
 * - single-flight start: concurrent runs share one helper start + availability
 *   check; a helper that dies is restarted on the next run;
 * - a run that times out or is cancelled sends `cancel`; if the helper doesn't
 *   answer within `stopGraceMs` it is killed, so nothing keeps generating;
 * - unavailability is a state (`unavailable` + reason), re-checked each run so
 *   turning Apple Intelligence on takes effect without a restart.
 */
export function createAppleEngine(options: AppleEngineOptions): WritingEngine {
	let status: EngineStatus = { state: "idle" };
	let helper: Helper | null = null;
	let starting: Promise<Helper> | null = null;
	let disposed = false;
	let nextId = 0;
	const setStatus = (next: EngineStatus) => {
		status = next;
	};

	const spawnHelper =
		options.spawnHelper ??
		((file: string) => {
			if (!existsSync(file))
				throw new Error(`Writing helper not found: ${file}`);
			return spawn(file, [], {
				stdio: ["pipe", "pipe", "pipe"],
			}) as ChildProcessWithoutNullStreams;
		});

	const startHelper = (): Helper => {
		const proc = spawnHelper(options.helperPath);
		const pending = new Map<string, (reply: Reply) => void>();
		let buffer = "";
		let alive = true;
		let stderr = "";
		const die = (why: string) => {
			if (!alive) return;
			alive = false;
			if (helper?.proc === proc) helper = null;
			for (const resolve of pending.values())
				resolve({ ok: false, code: "crashed", error: why });
			pending.clear();
		};
		proc.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line) continue;
				let reply: Reply;
				try {
					reply = JSON.parse(line) as Reply;
				} catch {
					continue;
				}
				const resolve = reply.id ? pending.get(reply.id) : undefined;
				if (resolve && reply.id) {
					pending.delete(reply.id);
					resolve(reply);
				}
			}
		});
		proc.stderr?.on("data", (chunk) => {
			stderr = (stderr + chunk.toString()).slice(-500);
		});
		proc.on("exit", (code) =>
			die(
				`The writing helper stopped (${String(code)})${stderr ? `: ${stderr.trim()}` : ""}`,
			),
		);
		proc.on("error", (error) =>
			die(error instanceof Error ? error.message : String(error)),
		);
		return {
			proc,
			alive: () => alive,
			request(body) {
				const id = `r${++nextId}`;
				const reply = new Promise<Reply>((resolve) => {
					if (!alive) {
						resolve({
							ok: false,
							code: "crashed",
							error: "helper not running",
						});
						return;
					}
					pending.set(id, resolve);
					proc.stdin.write(`${JSON.stringify({ id, ...body })}\n`);
				});
				return { id, reply };
			},
		};
	};

	const kill = (target: Helper | null) => {
		if (!target) return;
		if (helper === target) helper = null;
		try {
			target.proc.stdin.end();
			target.proc.kill();
		} catch {}
	};

	/** Single-flight: one live helper, started once, availability checked. */
	const ensure = (): Promise<Helper> => {
		if (helper?.alive()) return Promise.resolve(helper);
		if (starting) return starting;
		setStatus({ state: "loading" });
		let started: Helper | null = null;
		const attempt = (async () => {
			started = startHelper();
			const { reply } = started.request({ op: "availability" });
			const answer = await reply;
			if (!answer.ok)
				throw new Error(answer.error ?? "The writing helper did not start");
			return { helper: started, availability: answer.availability };
		})();
		starting = withTimeout(
			attempt,
			options.startTimeoutMs ?? 15_000,
			"Starting the writing helper",
		).then(
			(result) => {
				starting = null;
				if (disposed) {
					kill(result.helper);
					throw new Error("The writing engine was stopped");
				}
				helper = result.helper;
				if (isReason(result.availability))
					setStatus({ state: "unavailable", reason: result.availability });
				else setStatus({ state: "ready" });
				return result.helper;
			},
			(error: Error) => {
				starting = null;
				kill(started);
				if (!disposed) setStatus({ state: "failed", error: error.message });
				throw error;
			},
		);
		return starting;
	};

	const unavailable = (reason: UnavailableReason): EngineRunResult => {
		setStatus({ state: "unavailable", reason });
		return { status: "unavailable", reason, engine: status };
	};
	const fail = (message: string): EngineRunResult => {
		setStatus({ state: "failed", error: message });
		return { status: "failed", error: message, engine: status };
	};

	return {
		getStatus: () => status,
		async prewarm() {
			try {
				const live = await ensure();
				if (status.state === "ready") void live.request({ op: "prewarm" });
			} catch {
				// Visible as `failed` in the status; prewarm itself never throws.
			}
		},
		async run(prompt, signal) {
			if (signal?.aborted) return { status: "cancelled" };
			let live: Helper;
			try {
				live = await ensure();
				// Re-check availability each run (cheap) once it was unavailable.
				if (status.state === "unavailable") {
					const answer = await live.request({ op: "availability" }).reply;
					if (isReason(answer.availability))
						return unavailable(answer.availability);
					setStatus({ state: "ready" });
				}
			} catch (error) {
				if (signal?.aborted) return { status: "cancelled" };
				return {
					status: "failed",
					error: (error as Error).message,
					engine: status,
				};
			}
			if (signal?.aborted) return { status: "cancelled" };
			const { id, reply } = live.request({
				op: "run",
				prompt,
				maxTokens: 1024,
			});
			let stopReason: "cancel" | "timeout" | null = null;
			let wake: () => void = () => {};
			const stopped = new Promise<void>((resolve) => {
				wake = resolve;
			});
			const stop = (why: "cancel" | "timeout") => {
				if (stopReason) return;
				stopReason = why;
				live.request({ op: "cancel", target: id });
				wake();
			};
			const onAbort = () => stop("cancel");
			signal?.addEventListener("abort", onAbort, { once: true });
			const timer = setTimeout(
				() => stop("timeout"),
				options.runTimeoutMs ?? 60_000,
			);
			try {
				const first = await Promise.race([reply, stopped.then(() => null)]);
				if (first === null) {
					// Wait for the helper to confirm it stopped; kill it if it won't.
					const confirmed = await Promise.race([
						reply,
						new Promise<null>((r) =>
							setTimeout(() => r(null), options.stopGraceMs ?? 2_000),
						),
					]);
					if (confirmed === null) kill(live);
					if (stopReason === "cancel") {
						if (status.state !== "failed") setStatus({ state: "ready" });
						return { status: "cancelled" };
					}
					return fail(
						`The model timed out after ${Math.round((options.runTimeoutMs ?? 60_000) / 1000)}s`,
					);
				}
				if (first.ok && typeof first.text === "string") {
					setStatus({ state: "ready" });
					return { status: "done", text: first.text };
				}
				if (first.code === "cancelled") return { status: "cancelled" };
				if (isReason(first.code)) return unavailable(first.code);
				if (first.code === "too-long")
					return fail("The selection is too long for the on-device model");
				if (first.code === "refused")
					return fail("The on-device model declined this text");
				return fail(first.error ?? "The writing helper failed");
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
		async dispose() {
			disposed = true;
			const pending = starting;
			kill(helper);
			setStatus({ state: "idle" });
			if (pending) await pending.catch(() => undefined);
		},
	};
}

/**
 * Splits text into chunks of whole paragraphs (blank-line separated), each at
 * most `maxChars` where possible; a single over-long paragraph is split at
 * sentence ends. The on-device model's context is ~4096 tokens for
 * instructions + text + answer, so long selections run chunk by chunk.
 */
export function chunkByParagraph(text: string, maxChars: number): string[] {
	if (text.length <= maxChars) return [text];
	const pieces: string[] = [];
	for (const paragraph of text.split(/\n{2,}/)) {
		if (paragraph.length <= maxChars) {
			pieces.push(paragraph);
			continue;
		}
		let current = "";
		for (const sentence of paragraph.match(/[^.!?\n]+[.!?]*\s*|\n/g) ?? [
			paragraph,
		]) {
			if (current && current.length + sentence.length > maxChars) {
				pieces.push(current.trimEnd());
				current = "";
			}
			current += sentence;
		}
		if (current) pieces.push(current.trimEnd());
	}
	const chunks: string[] = [];
	let current = "";
	for (const piece of pieces) {
		if (current && current.length + 2 + piece.length > maxChars) {
			chunks.push(current);
			current = piece;
		} else current = current ? `${current}\n\n${piece}` : piece;
	}
	if (current) chunks.push(current);
	return chunks;
}

/** ~3 chars per token leaves room for instructions and an answer as long as the text. */
export const CHUNK_MAX_CHARS = 3_000;

/**
 * Runs a tool over each chunk in order and joins the answers with blank
 * lines. Stops at the first chunk that isn't `done` and returns that result,
 * so a cancel or failure mid-way never yields a half-rewritten selection.
 */
export async function runChunked(
	text: string,
	runOne: (chunk: string) => Promise<EngineRunResult>,
	maxChars = CHUNK_MAX_CHARS,
): Promise<EngineRunResult> {
	const outputs: string[] = [];
	for (const chunk of chunkByParagraph(text, maxChars)) {
		const result = await runOne(chunk);
		if (result.status !== "done") return result;
		outputs.push(result.text.trim());
	}
	return { status: "done", text: outputs.join("\n\n") };
}

export interface WritingEngineHost {
	getStatus(): EngineStatus;
	isRunning(): boolean;
	prewarm(): Promise<void>;
	/** Serialized: the on-device model runs one request at a time. */
	run(prompt: string): Promise<EngineRunResult>;
	/** Captures the cancel switch now; pass it to `runWith` for multi-step runs. */
	signal(): AbortSignal;
	runWith(prompt: string, signal: AbortSignal): Promise<EngineRunResult>;
	/** Stops the running generation and drops queued runs (they resolve `cancelled`). */
	cancel(): void;
	dispose(): Promise<void>;
}

/**
 * The single owner of the local engine in the app: the engine, the run queue
 * and the cancel switch. `main.ts` only calls this.
 */
export function createWritingEngineHost(deps: {
	createEngine: () => WritingEngine;
}): WritingEngineHost {
	let engine: WritingEngine | null = null;
	let queue: Promise<unknown> = Promise.resolve();
	let generation = new AbortController();
	let running = 0;

	const current = () => {
		if (!engine) engine = deps.createEngine();
		return engine;
	};

	const host: WritingEngineHost = {
		getStatus: () => engine?.getStatus() ?? { state: "idle" },
		isRunning: () => running > 0,
		prewarm: () => current().prewarm(),
		signal: () => generation.signal,
		run: (prompt) => host.runWith(prompt, generation.signal),
		runWith(prompt, signal) {
			const result = queue.then(async () => {
				if (signal.aborted) return { status: "cancelled" } as EngineRunResult;
				running++;
				try {
					return await current().run(prompt, signal);
				} finally {
					running--;
				}
			});
			queue = result.catch(() => undefined);
			return result;
		},
		cancel() {
			generation.abort();
			generation = new AbortController();
		},
		async dispose() {
			host.cancel();
			await queue;
			await engine?.dispose();
			engine = null;
		},
	};
	return host;
}
