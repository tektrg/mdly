import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createLlamaEngine,
	createWritingEngineHost,
	type LlamaModule,
} from "./writingEngine";

let root: string;
let modelA: string;
let modelB: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "writing-engine-"));
	modelA = path.join(root, "a.gguf");
	modelB = path.join(root, "b.gguf");
	await fs.writeFile(modelA, "x");
	await fs.writeFile(modelB, "x");
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

/** A fake llama module that counts live models and lets prompts hang until aborted. */
function fakeLlama(
	opts: { loadDelayMs?: number; hang?: boolean; contextFails?: boolean } = {},
) {
	const stats = {
		loads: 0,
		live: 0,
		maxLive: 0,
		promptAborted: 0,
		contextsDisposedWhilePrompting: 0,
	};
	let prompting = 0;
	const mod: LlamaModule = {
		getLlama: async () => ({
			loadModel: async () => {
				stats.loads++;
				if (opts.loadDelayMs)
					await new Promise((r) => setTimeout(r, opts.loadDelayMs));
				stats.live++;
				stats.maxLive = Math.max(stats.maxLive, stats.live);
				return {
					createContext: async () => {
						if (opts.contextFails) throw new Error("no memory for context");
						return {
							getSequence: () => ({}),
							dispose: async () => {
								if (prompting > 0) stats.contextsDisposedWhilePrompting++;
							},
						};
					},
					dispose: async () => {
						stats.live--;
					},
				};
			},
		}),
		LlamaChatSession: class {
			prompt(text: string, o?: { signal?: AbortSignal }) {
				prompting++;
				return new Promise<string>((resolve, reject) => {
					const done = () => {
						prompting--;
					};
					if (!opts.hang) {
						done();
						resolve(`echo:${text}`);
						return;
					}
					o?.signal?.addEventListener("abort", () => {
						stats.promptAborted++;
						// Generation stops a moment after the abort, like the real thing.
						setTimeout(() => {
							done();
							reject(new Error("aborted"));
						}, 5);
					});
				});
			}
		} as unknown as LlamaModule["LlamaChatSession"],
	};
	return { mod, stats };
}

describe("llama engine lifecycle", () => {
	it("a timed-out run really stops generating, then reports failed", async () => {
		const { mod, stats } = fakeLlama({ hang: true });
		const engine = createLlamaEngine({
			modelPath: modelA,
			runTimeoutMs: 20,
			loadModule: async () => mod,
		});
		const result = await engine.run("p");
		expect(result).toMatchObject({ status: "failed" });
		expect(stats.promptAborted).toBe(1);
		expect(stats.contextsDisposedWhilePrompting).toBe(0);
		expect(engine.getStatus().state).toBe("failed");
	});

	it("a run that fails to start sets the failed status", async () => {
		const { mod } = fakeLlama({ contextFails: true });
		const engine = createLlamaEngine({
			modelPath: modelA,
			loadModule: async () => mod,
		});
		const result = await engine.run("p");
		expect(result).toMatchObject({ status: "failed" });
		expect(engine.getStatus()).toMatchObject({
			state: "failed",
			error: expect.stringMatching(/no memory/),
		});
	});

	it("a load that finishes after its timeout does not leak the model", async () => {
		const { mod, stats } = fakeLlama({ loadDelayMs: 40 });
		const engine = createLlamaEngine({
			modelPath: modelA,
			loadTimeoutMs: 10,
			loadModule: async () => mod,
		});
		expect((await engine.run("p")).status).toBe("failed");
		await new Promise((r) => setTimeout(r, 60));
		expect(stats.live).toBe(0);
	});
});

describe("writing engine host", () => {
	it("loads once for concurrent runs (single flight)", async () => {
		const { mod, stats } = fakeLlama({ loadDelayMs: 10 });
		const host = createWritingEngineHost({
			createEngine: (modelPath) =>
				createLlamaEngine({ modelPath, loadModule: async () => mod }),
		});
		await host.setModelPath(modelA);
		const results = await Promise.all([host.run("a"), host.run("b")]);
		expect(results.map((r) => r.status)).toEqual(["done", "done"]);
		expect(stats.loads).toBe(1);
	});

	it("cancel stops the running generation and reports cancelled", async () => {
		const { mod, stats } = fakeLlama({ hang: true });
		const host = createWritingEngineHost({
			createEngine: (modelPath) =>
				createLlamaEngine({ modelPath, loadModule: async () => mod }),
		});
		await host.setModelPath(modelA);
		const running = host.run("p");
		await new Promise((r) => setTimeout(r, 10));
		expect(host.isRunning()).toBe(true);
		host.cancel();
		expect(await running).toEqual({ status: "cancelled" });
		expect(stats.promptAborted).toBe(1);
		expect(host.isRunning()).toBe(false);
		// Not a failure: the engine stays usable.
		expect(host.getStatus().state).toBe("ready");
	});

	it("changing the model path mid-run cancels first and never holds two models", async () => {
		const { mod, stats } = fakeLlama({ hang: true });
		const host = createWritingEngineHost({
			createEngine: (modelPath) =>
				createLlamaEngine({ modelPath, loadModule: async () => mod }),
		});
		await host.setModelPath(modelA);
		const running = host.run("p");
		await new Promise((r) => setTimeout(r, 10));
		await host.setModelPath(modelB);
		expect(await running).toEqual({ status: "cancelled" });
		expect(stats.live).toBe(0);
		expect(host.getStatus().modelPath).toBe(modelB);
		const next = host.run("q");
		await new Promise((r) => setTimeout(r, 10));
		host.cancel();
		await next;
		expect(stats.maxLive).toBe(1);
	});

	it("switching the model while it is still loading disposes the old one", async () => {
		const { mod, stats } = fakeLlama({ loadDelayMs: 30 });
		const host = createWritingEngineHost({
			createEngine: (modelPath) =>
				createLlamaEngine({ modelPath, loadModule: async () => mod }),
		});
		await host.setModelPath(modelA);
		const first = host.run("a");
		await new Promise((r) => setTimeout(r, 5));
		await host.setModelPath(modelB);
		expect((await first).status).toBe("cancelled");
		expect((await host.run("b")).status).toBe("done");
		expect(stats.maxLive).toBe(1);
		expect(stats.live).toBe(1);
	});

	it("a run requested while a model switch is still pending never deadlocks", async () => {
		const { mod } = fakeLlama({ hang: true });
		const host = createWritingEngineHost({
			createEngine: (modelPath) =>
				createLlamaEngine({ modelPath, loadModule: async () => mod }),
		});
		await host.setModelPath(modelA);
		const first = host.run("a");
		await new Promise((r) => setTimeout(r, 5));
		// The settings change and a status poll both sync the path before a new run.
		const switching = host.setModelPath(modelB);
		void host.setModelPath(modelB);
		const next = host.run("b");
		expect((await first).status).toBe("cancelled");
		await switching;
		host.cancel();
		const outcome = await Promise.race([
			next.then((r) => r.status),
			new Promise((r) => setTimeout(() => r("deadlock"), 1000)),
		]);
		expect(outcome).toBe("cancelled");
	});
});
