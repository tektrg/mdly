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
	getLlama: () => Promise<{
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

export function createLlamaEngine(options: LlamaEngineOptions): WritingEngine {
	let status: EngineStatus = { state: "idle", modelPath: options.modelPath };
	type Loaded = {
		mod: LlamaModule;
		model: Awaited<
			ReturnType<Awaited<ReturnType<LlamaModule["getLlama"]>>["loadModel"]>
		>;
	};
	let loading: Promise<Loaded> | null = null;

	const load = (): Promise<Loaded> => {
		if (loading) return loading;
		status = { state: "loading", modelPath: options.modelPath };
		loading = (async () => {
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
			const llama = await mod.getLlama();
			const model = await llama.loadModel({ modelPath: options.modelPath });
			return { mod, model };
		})();
		loading = withTimeout(
			loading,
			options.loadTimeoutMs ?? 60_000,
			"Loading the model",
		).then(
			(loaded) => {
				status = { state: "ready", modelPath: options.modelPath };
				return loaded;
			},
			(error: Error & { missing?: boolean }) => {
				status = {
					state: error.missing ? "missing" : "failed",
					modelPath: options.modelPath,
					error: error.message,
				};
				loading = null; // allow a retry (e.g. after the file appears)
				throw error;
			},
		);
		return loading;
	};

	return {
		getStatus: () => status,
		async run(prompt, signal) {
			let loaded: Loaded;
			try {
				loaded = await load();
			} catch (error) {
				return {
					status: "failed",
					error: (error as Error).message,
					engine: status,
				};
			}
			// Fresh context per run: tools are one-shot, and this keeps runs independent.
			const context = await loaded.model.createContext();
			try {
				const session = new loaded.mod.LlamaChatSession({
					contextSequence: context.getSequence(),
				});
				const text = await withTimeout(
					session.prompt(prompt, { signal, maxTokens: 1024, temperature: 0.2 }),
					options.runTimeoutMs ?? 120_000,
					"The model",
				);
				status = { state: "ready", modelPath: options.modelPath };
				return { status: "done", text };
			} catch (error) {
				const message = (error as Error).message;
				return {
					status: "failed",
					error: message,
					engine: { ...status, error: message },
				};
			} finally {
				await context.dispose().catch(() => undefined);
			}
		},
		async dispose() {
			const pending = loading;
			loading = null;
			status = { state: "idle", modelPath: options.modelPath };
			if (pending) {
				const loaded = await pending.catch(() => null);
				await loaded?.model.dispose().catch(() => undefined);
			}
		},
	};
}
