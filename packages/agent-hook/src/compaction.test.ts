import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendHookEvent,
	createProposalReader,
	eventsPath,
	type HookEvent,
	newHookEvent,
	readHookEvents,
} from "./events.js";
import { watchHookEvents } from "./watch.js";

let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hook-compact-"));
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

const propose = (id: string) =>
	newHookEvent("edit.proposed", "a.md", "agent", {
		proposalId: id,
		find: `find ${id}`,
		replace: `replace ${id}`,
	});
const settle = (id: string) =>
	newHookEvent("suggestion.rejected", "a.md", "user", { proposalId: id });
const comment = (text: string) =>
	newHookEvent("comment.added", "a.md", "user", { text: text.padEnd(200) });

describe("event file bounding", () => {
	it("compacts past the threshold, keeping only pending proposals", async () => {
		const opts = { compactAtBytes: 2_000 };
		await appendHookEvent(root, propose("keep"), opts);
		await appendHookEvent(root, propose("gone"), opts);
		await appendHookEvent(root, settle("gone"), opts);
		for (let i = 0; i < 20; i++)
			await appendHookEvent(root, comment(`c${i}`), opts);
		const size = (await fs.stat(eventsPath(root, "a.md"))).size;
		expect(size).toBeLessThan(2_000);
		const events = await readHookEvents(root, "a.md");
		expect(
			events.filter((e) => e.type === "edit.proposed").map((e) => e.proposalId),
		).toEqual(["keep"]);
		// The previous generation is kept once (one rotated file), not forever.
		const files = await fs.readdir(path.dirname(eventsPath(root, "a.md")));
		expect(files.filter((f) => f.includes(".events.")).length).toBeLessThan(3);
	});

	it("a watcher sees every user event exactly once across a compaction", async () => {
		const opts = { compactAtBytes: 1_500 };
		const seen: HookEvent[] = [];
		const controller = new AbortController();
		const done = watchHookEvents({
			workspaceRoot: root,
			doc: "a.md",
			intervalMs: 5,
			signal: controller.signal,
			onEvent: (e) => seen.push(e),
		});
		await new Promise((r) => setTimeout(r, 20));
		await appendHookEvent(root, propose("p"), opts);
		for (let i = 0; i < 15; i++) {
			await appendHookEvent(root, comment(`c${i}`), opts);
			if (i % 3 === 0) await new Promise((r) => setTimeout(r, 15));
		}
		await new Promise((r) => setTimeout(r, 60));
		controller.abort();
		await done;
		expect(seen.map((e) => String(e.text).trim())).toEqual(
			Array.from({ length: 15 }, (_, i) => `c${i}`),
		);
	});
});

describe("incremental proposal reader", () => {
	it("re-reads only new bytes and stays correct after compaction", async () => {
		const reader = createProposalReader();
		await appendHookEvent(root, propose("p1"));
		expect((await reader.read(root, "a.md")).map((p) => p.proposalId)).toEqual([
			"p1",
		]);
		expect(reader.lastReadBytes).toBeGreaterThan(0);
		// Nothing new: no bytes read.
		await reader.read(root, "a.md");
		expect(reader.lastReadBytes).toBe(0);
		const before = (await fs.stat(eventsPath(root, "a.md"))).size;
		await appendHookEvent(root, propose("p2"));
		await appendHookEvent(root, settle("p1"));
		expect((await reader.read(root, "a.md")).map((p) => p.proposalId)).toEqual([
			"p2",
		]);
		const after = (await fs.stat(eventsPath(root, "a.md"))).size;
		expect(reader.lastReadBytes).toBe(after - before);
		for (let i = 0; i < 20; i++)
			await appendHookEvent(root, comment(`c${i}`), { compactAtBytes: 1_500 });
		expect((await reader.read(root, "a.md")).map((p) => p.proposalId)).toEqual([
			"p2",
		]);
	});

	it("returns nothing for a doc with no events", async () => {
		expect(await createProposalReader().read(root, "none.md")).toEqual([]);
	});
});
