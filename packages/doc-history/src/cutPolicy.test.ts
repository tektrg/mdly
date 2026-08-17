import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCutPolicy } from "./cutPolicy.js";
import { createHistoryStore } from "./historyStore.js";
import type { RevisionAuthor } from "./revisionLog.js";
import {
	createFakeCompressor,
	createMemoryFileSystem,
} from "./testing/memoryFs.js";

const HUMAN: RevisionAuthor = { kind: "human", id: "device-1" };
const IDLE_MS = 3 * 60 * 1000;
const FORCED_MS = 30 * 60 * 1000;

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("createCutPolicy (R15, R16)", () => {
	it("fires exactly one idle cut after 3 minutes of silence following keystrokes", () => {
		const cuts: string[] = [];
		const policy = createCutPolicy((cause) => cuts.push(cause), {
			idleMs: IDLE_MS,
			forcedMs: FORCED_MS,
		});

		for (let i = 0; i < 5; i++) {
			policy.onEdit();
			vi.advanceTimersByTime(500);
		}
		vi.advanceTimersByTime(IDLE_MS);

		expect(cuts).toEqual(["idle-session"]);
	});

	it("resets the idle clock on a late keystroke so the original 3-minute mark does not fire", () => {
		const cuts: string[] = [];
		const policy = createCutPolicy((cause) => cuts.push(cause), {
			idleMs: IDLE_MS,
			forcedMs: FORCED_MS,
		});

		policy.onEdit();
		vi.advanceTimersByTime(IDLE_MS - 1000); // 2:59
		policy.onEdit(); // resets the clock
		vi.advanceTimersByTime(1000); // would have been the original 3:00 mark
		expect(cuts).toEqual([]);

		vi.advanceTimersByTime(IDLE_MS - 1000); // now 3:00 after the reset keystroke
		expect(cuts).toEqual(["idle-session"]);
	});

	it("fires a forced cut at the 30-minute ceiling during continuous sub-3-minute-gap typing, and timers continue afterward", () => {
		const cuts: string[] = [];
		const policy = createCutPolicy((cause) => cuts.push(cause), {
			idleMs: IDLE_MS,
			forcedMs: FORCED_MS,
		});

		// Keystrokes every 2 minutes for 30 minutes: idle timer never gets a
		// long enough gap to fire.
		for (let i = 0; i < 15; i++) {
			policy.onEdit();
			vi.advanceTimersByTime(2 * 60 * 1000);
		}

		expect(cuts).toEqual(["forced"]);

		// Typing continues past the ceiling: another forced cut 30 minutes later.
		for (let i = 0; i < 15; i++) {
			policy.onEdit();
			vi.advanceTimersByTime(2 * 60 * 1000);
		}
		expect(cuts).toEqual(["forced", "forced"]);
	});

	it("does not fire at all when there was no pending edit (no phantom cuts)", () => {
		const cuts: string[] = [];
		createCutPolicy((cause) => cuts.push(cause), {
			idleMs: IDLE_MS,
			forcedMs: FORCED_MS,
		});
		vi.advanceTimersByTime(FORCED_MS * 2);
		expect(cuts).toEqual([]);
	});
});

describe("dedupe and markdown-only skip rules apply the same regardless of cut cause (R6, R7)", () => {
	function makeStore() {
		const fs = createMemoryFileSystem();
		const compressor = createFakeCompressor();
		return createHistoryStore({ fs, compressor, workspaceRoot: "/ws" });
	}

	it("an identical-content save never produces a new log line, on any cause", async () => {
		const store = makeStore();
		await store.recordRevision("note.md", "same", {
			by: HUMAN,
			cause: "idle-session",
		});
		const skipped = await store.recordRevision("note.md", "same", {
			by: HUMAN,
			cause: "external-write",
		});
		expect(skipped).toMatchObject({ status: "skipped", reason: "duplicate" });
		expect(await store.getRevisionHistory("note.md")).toHaveLength(1);
	});

	it("a non-Markdown path is rejected outright: no blob, no log line, no id assigned", async () => {
		const store = makeStore();
		const result = await store.recordRevision(
			"image.png",
			"not really markdown",
			{
				by: HUMAN,
				cause: "manual",
			},
		);
		expect(result).toEqual({ status: "skipped", reason: "not-markdown" });
		expect(await store.getRevisionHistory("image.png")).toEqual([]);
	});

	it("dedupe applies across cut causes: an identical external 'touch' is also skipped (R6, dedupe-applies-across-all-cut-causes)", async () => {
		const store = makeStore();
		await store.recordRevision("note.md", "steady content", {
			by: HUMAN,
			cause: "manual",
		});
		const externalTouch = await store.recordRevision(
			"note.md",
			"steady content",
			{
				by: { kind: "external", id: "watcher" },
				cause: "external-write",
			},
		);
		expect(externalTouch).toMatchObject({
			status: "skipped",
			reason: "duplicate",
		});
		expect(await store.getRevisionHistory("note.md")).toHaveLength(1);
	});
});
