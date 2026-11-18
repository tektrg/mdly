import { describe, expect, it } from "vitest";
import {
	chunkByParagraph,
	createAppleEngine,
	createWritingEngineHost,
	type HelperProcess,
	helperPath,
	runChunked,
} from "./writingEngine";

type Request = { id: string; op: string; prompt?: string; target?: string };

/**
 * A fake Swift helper: answers JSON lines like the real one. `hang` keeps runs
 * open until cancelled; `ignoreCancel` makes it never stop (so it gets killed).
 */
function fakeHelper(
	opts: {
		availability?: string;
		hang?: boolean;
		ignoreCancel?: boolean;
		runCode?: string;
		silent?: boolean;
	} = {},
) {
	const stats = { spawns: 0, kills: 0, cancels: 0, runs: 0, prewarms: 0 };
	const spawnHelper = (): HelperProcess => {
		stats.spawns++;
		let onData: (chunk: string) => void = () => {};
		let onExit: (code: number | null) => void = () => {};
		const open = new Set<string>();
		const reply = (o: object) =>
			setTimeout(() => onData(`${JSON.stringify(o)}\n`), 1);
		return {
			stdin: {
				write(line: string) {
					const req = JSON.parse(line) as Request;
					if (opts.silent) return;
					if (req.op === "availability")
						reply({
							id: req.id,
							ok: true,
							availability: opts.availability ?? "available",
						});
					else if (req.op === "prewarm") {
						stats.prewarms++;
						reply({ id: req.id, ok: true });
					} else if (req.op === "cancel") {
						stats.cancels++;
						reply({ id: req.id, ok: true });
						if (!opts.ignoreCancel && req.target && open.delete(req.target))
							reply({ id: req.target, ok: false, code: "cancelled" });
					} else if (req.op === "run") {
						stats.runs++;
						if (opts.runCode)
							reply({ id: req.id, ok: false, code: opts.runCode, error: "x" });
						else if (opts.hang) open.add(req.id);
						else reply({ id: req.id, ok: true, text: `echo:${req.prompt}` });
					}
				},
				end() {},
			},
			stdout: {
				on: (_e, fn) => {
					onData = (c) => fn(c);
				},
			},
			on: (event, fn) => {
				if (event === "exit") onExit = fn as (c: number | null) => void;
			},
			kill() {
				stats.kills++;
				onExit(null);
			},
		};
	};
	return { spawnHelper, stats };
}

describe("apple engine", () => {
	it("runs through the helper and reports ready", async () => {
		const { spawnHelper } = fakeHelper();
		const engine = createAppleEngine({ helperPath: "h", spawnHelper });
		expect(await engine.run("hi")).toEqual({ status: "done", text: "echo:hi" });
		expect(engine.getStatus().state).toBe("ready");
	});

	it("Apple Intelligence off is a visible 'unavailable' state with the reason", async () => {
		const { spawnHelper, stats } = fakeHelper({
			availability: "apple-intelligence-off",
		});
		const engine = createAppleEngine({ helperPath: "h", spawnHelper });
		expect(await engine.run("hi")).toMatchObject({
			status: "unavailable",
			reason: "apple-intelligence-off",
		});
		expect(engine.getStatus()).toEqual({
			state: "unavailable",
			reason: "apple-intelligence-off",
		});
		expect(stats.runs).toBe(0);
	});

	it("an unsupported language on a run is 'unavailable', not a crash", async () => {
		const { spawnHelper } = fakeHelper({ runCode: "unsupported-language" });
		const engine = createAppleEngine({ helperPath: "h", spawnHelper });
		expect(await engine.run("hi")).toMatchObject({
			status: "unavailable",
			reason: "unsupported-language",
		});
	});

	it("a missing helper is 'failed', not a hang", async () => {
		const engine = createAppleEngine({
			helperPath: "/nope/mdly-writing-helper",
		});
		const result = await engine.run("hi");
		expect(result.status).toBe("failed");
		expect(engine.getStatus()).toMatchObject({
			state: "failed",
			error: expect.stringMatching(/not found/),
		});
	});

	it("a helper that never answers times out into 'failed'", async () => {
		const { spawnHelper } = fakeHelper({ silent: true });
		const engine = createAppleEngine({
			helperPath: "h",
			spawnHelper,
			startTimeoutMs: 30,
		});
		expect((await engine.run("hi")).status).toBe("failed");
		expect(engine.getStatus().error).toMatch(/timed out/);
	});

	it("single-flight start: concurrent runs share one helper", async () => {
		const { spawnHelper, stats } = fakeHelper();
		const engine = createAppleEngine({ helperPath: "h", spawnHelper });
		await Promise.all([engine.run("a"), engine.run("b"), engine.prewarm()]);
		expect(stats.spawns).toBe(1);
	});

	it("prewarm starts the helper and asks it to load the model", async () => {
		const { spawnHelper, stats } = fakeHelper();
		const engine = createAppleEngine({ helperPath: "h", spawnHelper });
		await engine.prewarm();
		await new Promise((r) => setTimeout(r, 10));
		expect(stats.prewarms).toBe(1);
		expect(engine.getStatus().state).toBe("ready");
	});

	it("a timed-out run cancels in the helper, then reports failed", async () => {
		const { spawnHelper, stats } = fakeHelper({ hang: true });
		const engine = createAppleEngine({
			helperPath: "h",
			spawnHelper,
			runTimeoutMs: 30,
		});
		const result = await engine.run("hi");
		expect(result).toMatchObject({
			status: "failed",
			error: expect.stringMatching(/timed out/),
		});
		expect(stats.cancels).toBe(1);
		expect(stats.kills).toBe(0);
	});

	it("a helper that ignores cancel is killed, and the next run restarts it", async () => {
		const { spawnHelper, stats } = fakeHelper({
			hang: true,
			ignoreCancel: true,
		});
		const engine = createAppleEngine({
			helperPath: "h",
			spawnHelper,
			runTimeoutMs: 20,
			stopGraceMs: 20,
		});
		await engine.run("hi");
		expect(stats.kills).toBe(1);
		await engine.run("again");
		expect(stats.spawns).toBe(2);
	});

	it("host cancel stops the running run and drops queued ones", async () => {
		const { spawnHelper, stats } = fakeHelper({ hang: true });
		const host = createWritingEngineHost({
			createEngine: () => createAppleEngine({ helperPath: "h", spawnHelper }),
		});
		const first = host.run("a");
		const second = host.run("b");
		await new Promise((r) => setTimeout(r, 20));
		expect(host.isRunning()).toBe(true);
		host.cancel();
		expect(await first).toEqual({ status: "cancelled" });
		expect(await second).toEqual({ status: "cancelled" });
		expect(stats.runs).toBe(1);
		expect(host.getStatus().state).toBe("ready");
	});
});

describe("chunking", () => {
	it("keeps short text whole", () => {
		expect(chunkByParagraph("one\n\ntwo", 100)).toEqual(["one\n\ntwo"]);
	});
	it("groups whole paragraphs under the limit", () => {
		const p = "x".repeat(40);
		expect(chunkByParagraph([p, p, p].join("\n\n"), 90)).toEqual([
			`${p}\n\n${p}`,
			p,
		]);
	});
	it("splits an over-long paragraph at sentence ends", () => {
		const chunks = chunkByParagraph("Aaaa aaaa. Bbbb bbbb. Cccc cccc.", 12);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((c) => c.length <= 12)).toBe(true);
	});
	it("never drops punctuation that starts a sentence (ellipses, ?!)", () => {
		const paragraph = "Wait!!! ...and then. ?! Really... .Done.";
		const chunks = chunkByParagraph(paragraph, 10);
		const squash = (s: string) => s.replace(/\s+/g, "");
		expect(squash(chunks.join(""))).toBe(squash(paragraph));
	});
	it("runs each chunk and joins, stopping at the first non-done", async () => {
		const p = "y".repeat(40);
		const text = [p, p, p].join("\n\n");
		const done = await runChunked(
			text,
			async (c) => ({ status: "done", text: c.toUpperCase() }),
			50,
		);
		expect(done).toEqual({ status: "done", text: text.toUpperCase() });
		let calls = 0;
		const stopped = await runChunked(
			text,
			async () =>
				++calls === 2 ? { status: "cancelled" } : { status: "done", text: "z" },
			50,
		);
		expect(stopped).toEqual({ status: "cancelled" });
		expect(calls).toBe(2);
	});
});

describe("helperPath", () => {
	it("uses Contents/MacOS in the packaged app", () => {
		expect(helperPath("/A.app/Contents/Resources", "/dev", () => true)).toBe(
			"/A.app/Contents/MacOS/mdly-writing-helper",
		);
	});
	it("falls back to the dev build", () => {
		expect(helperPath(undefined, "/dev")).toBe(
			"/dev/native/build/mdly-writing-helper",
		);
	});
});
