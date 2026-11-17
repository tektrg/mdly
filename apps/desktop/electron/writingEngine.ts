/**
 * The local writing engine behind "the dot". One status owner per engine:
 * `status` moves idle → loading → ready, or to `missing` (no model file) /
 * `failed` (load or run error). A missing or broken model is a visible state,
 * never a hang: loading and each run are bounded by timeouts.
 *
 * `createLlamaEngine` runs a GGUF model in the main process via
 * node-llama-cpp (loaded lazily, so the app starts without it).
 * `createFakeEngine` is for tests.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * node-llama-cpp is native + ESM-only, so it must NOT be bundled into the CJS
 * main bundle: it is loaded at runtime from the packaged app's node_modules
 * (see `build.asarUnpack` in package.json). A variable specifier keeps the
 * bundler from trying to inline it.
 */
const LLAMA_MODULE = "node-llama-cpp";
const importNative = new Function("specifier", "return import(specifier)") as (
	specifier: string,
) => Promise<unknown>;

export const DEFAULT_MODEL_PATH = path.join(
	os.homedir(),
	"Library",
	"Application Support",
	"com.mshl.ghostwriter",
	"Models",
	"gemma-3-1b.i1-Q5_K_M.gguf",
);

export type EngineState = "idle" | "loading" | "ready" | "missing" | "failed";

export interface EngineStatus {
	state: EngineState;
	modelPath: string;
	error?: string;
}

export type EngineRunResult =
	| { status: "done"; text: string }
	| { status: "cancelled" }
	| { status: "failed"; error: string; engine: EngineStatus };

export interface WritingEngine {
	getStatus(): EngineStatus;
	run(prompt: string, signal?: AbortSignal): Promise<EngineRunResult>;
	dispose(): Promise<void>;
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
	modelPath?: string;
	respond?: (prompt: string) => string | Promise<string>;
	failWith?: string;
}

export function createFakeEngine(
	options: FakeEngineOptions = {},
): WritingEngine {
	let status: EngineStatus = {
		state: "idle",
		modelPath: options.modelPath ?? "fake",
	};
	return {
		getStatus: () => status,
		async run(prompt) {
			if (options.failWith) {
				status = { ...status, state: "failed", error: options.failWith };
				return { status: "failed", error: options.failWith, engine: status };
			}
			status = { ...status, state: "ready", error: undefined };
			return {
				status: "done",
				text: await (options.respond ?? ((p) => p))(prompt),
			};
		},
		async dispose() {},
	};
}

export interface LlamaEngineOptions {
	modelPath: string;
	loadTimeoutMs?: number;
	runTimeoutMs?: number;
	/** Injected for tests; defaults to `import("node-llama-cpp")`. */
	loadModule?: () => Promise<LlamaModule>;
}

/** The slice of node-llama-cpp this engine uses (kept narrow so a fake can stand in). */
export interface LlamaModule {
	getLlama: (o?: { build?: "never" | "auto" }) => Promise<{
		loadModel: (o: { modelPath: string }) => Promise<{
			createContext: () => Promise<{
				getSequence: () => unknown;
				dispose: () => Promise<void>;
			}>;
			dispose: () => Promise<void>;
		}>;
	}>;
	LlamaChatSession: new (o: {
		contextSequence: unknown;
	}) => {
		prompt: (
			text: string,
			o?: { signal?: AbortSignal; maxTokens?: number; temperature?: number },
		) => Promise<string>;
	};
}

type LoadedModel = Awaited<
	ReturnType<Awaited<ReturnType<LlamaModule["getLlama"]>>["loadModel"]>
>;

function cancelled(signal?: AbortSignal): boolean {
	return signal?.aborted === true;
}

/** Resolves when `signal` aborts (never rejects). */
function whenAborted(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) resolve();
		else signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

/**
 * One engine per model path. Lifecycle rules:
 * - single-flight load: concurrent runs share one load; a model that finishes
 *   loading after a timeout or after `dispose` is disposed at once, so at most
 *   one copy is ever held;
 * - a run that times out or is cancelled aborts generation and waits for it to
 *   stop before freeing its context;
 * - every failure (load, context creation, generation) sets `failed`.
 */
export function createLlamaEngine(options: LlamaEngineOptions): WritingEngine {
	let status: EngineStatus = { state: "idle", modelPath: options.modelPath };
	let disposed = false;
	let loaded: { mod: LlamaModule; model: LoadedModel } | null = null;
	let loading: Promise<{ mod: LlamaModule; model: LoadedModel }> | null = null;
	const setStatus = (state: EngineState, error?: string) => {
		status = { state, modelPath: options.modelPath, error };
	};

	const load = () => {
		if (loaded) return Promise.resolve(loaded);
		if (loading) return loading;
		setStatus("loading");
		const attempt = (async () => {
			try {
				await fs.access(options.modelPath);
			} catch {
				throw Object.assign(
					new Error(`Model file not found: ${options.modelPath}`),
					{ missing: true },
				);
			}
			const mod = await (
				options.loadModule ??
				(() => importNative(LLAMA_MODULE) as Promise<LlamaModule>)
			)();
			// Prebuilt binaries only: never compile llama.cpp on a user's Mac.
			const llama = await mod.getLlama({ build: "never" });
			const model = await llama.loadModel({ modelPath: options.modelPath });
			return { mod, model };
		})();
		let timedOut = false;
		// A load that outlives its timeout (or the engine) must not leak a model.
		void attempt.then(
			(late) => {
				if (timedOut || disposed) void late.model.dispose().catch(() => {});
			},
			() => undefined,
		);
		loading = withTimeout(
			attempt,
			options.loadTimeoutMs ?? 60_000,
			"Loading the model",
		).then(
			(result) => {
				loading = null;
				if (disposed) throw new Error("The model was unloaded");
				loaded = result;
				setStatus("ready");
				return result;
			},
			(error: Error & { missing?: boolean }) => {
				timedOut = /timed out/.test(error.message);
				loading = null; // allow a retry (e.g. after the file appears)
				if (!disposed)
					setStatus(error.missing ? "missing" : "failed", error.message);
				throw error;
			},
		);
		return loading;
	};

	const fail = (message: string): EngineRunResult => {
		setStatus("failed", message);
		return { status: "failed", error: message, engine: status };
	};

	return {
		getStatus: () => status,
		async run(prompt, signal) {
			if (cancelled(signal)) return { status: "cancelled" };
			let model: { mod: LlamaModule; model: LoadedModel };
			try {
				const pending = load();
				model = signal
					? await Promise.race([
							pending,
							whenAborted(signal).then(() => null),
						]).then((m) => {
							if (!m)
								throw Object.assign(new Error("cancelled"), { cancel: true });
							return m;
						})
					: await pending;
			} catch (error) {
				if ((error as { cancel?: boolean }).cancel || cancelled(signal))
					return { status: "cancelled" };
				return {
					status: "failed",
					error: (error as Error).message,
					engine: status,
				};
			}
			if (cancelled(signal)) return { status: "cancelled" };
			// Our own controller: a timeout or an outside cancel both abort generation.
			const stop = new AbortController();
			const onAbort = () => stop.abort();
			signal?.addEventListener("abort", onAbort, { once: true });
			let context: Awaited<ReturnType<LoadedModel["createContext"]>> | null =
				null;
			try {
				// Fresh context per run: tools are one-shot, and this keeps runs independent.
				context = await model.model.createContext();
				const session = new model.mod.LlamaChatSession({
					contextSequence: context.getSequence(),
				});
				const generation = session.prompt(prompt, {
					signal: stop.signal,
					maxTokens: 1024,
					temperature: 0.2,
				});
				try {
					const text = await withTimeout(
						generation,
						options.runTimeoutMs ?? 120_000,
						"The model",
					);
					setStatus("ready");
					return { status: "done", text };
				} catch (error) {
					stop.abort();
					// Wait for generation to actually stop before freeing its context.
					await generation.catch(() => undefined);
					if (cancelled(signal)) {
						setStatus("ready");
						return { status: "cancelled" };
					}
					return fail((error as Error).message);
				}
			} catch (error) {
				if (cancelled(signal)) return { status: "cancelled" };
				return fail((error as Error).message);
			} finally {
				signal?.removeEventListener("abort", onAbort);
				await context?.dispose().catch(() => undefined);
			}
		},
		async dispose() {
			disposed = true;
			const pending = loading;
			const current = loaded;
			loading = null;
			loaded = null;
			setStatus("idle");
			await current?.model.dispose().catch(() => undefined);
			if (pending) await pending.catch(() => undefined);
		},
	};
}

export interface WritingEngineHost {
	getStatus(): EngineStatus;
	isRunning(): boolean;
	/** Serialized: a local model has one context budget. */
	run(prompt: string): Promise<EngineRunResult>;
	/** Stops the running generation and drops queued runs (they resolve `cancelled`). */
	cancel(): void;
	/** Cancels any run, waits for it to stop, unloads the old model, then switches. */
	setModelPath(modelPath: string): Promise<void>;
	dispose(): Promise<void>;
}

/**
 * The single owner of the local model in the app: which engine is current,
 * the run queue and the cancel switch. `main.ts` only calls this.
 */
export function createWritingEngineHost(deps: {
	createEngine: (modelPath: string) => WritingEngine;
}): WritingEngineHost {
	let engine: WritingEngine | null = null;
	let modelPath = "";
	let queue: Promise<unknown> = Promise.resolve();
	let generation = new AbortController();
	let running = 0;
	let switching: Promise<void> = Promise.resolve();
	let targetPath = "";
	let switchesPending = 0;

	const current = () => {
		if (!engine) engine = deps.createEngine(modelPath);
		return engine;
	};

	const host: WritingEngineHost = {
		getStatus: () => engine?.getStatus() ?? { state: "idle", modelPath },
		isRunning: () => running > 0,
		run(prompt) {
			const signal = generation.signal;
			const result = Promise.all([queue, switching]).then(async () => {
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
		setModelPath(next) {
			// Compare with the path the queued switches lead to, not the live one.
			if (next === targetPath && (engine || switchesPending > 0))
				return switching;
			targetPath = next;
			// Captured now: a run requested later waits on this switch, so awaiting
			// it from inside the switch would deadlock.
			host.cancel(); // now, so runs requested after this get a live signal
			const drain = queue;
			switchesPending++;
			switching = switching.then(async () => {
				await drain;
				const old = engine;
				engine = null;
				modelPath = next;
				try {
					await old?.dispose();
				} finally {
					switchesPending--;
				}
			});
			return switching;
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
