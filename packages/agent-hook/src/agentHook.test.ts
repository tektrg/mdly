import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendHookEvent,
	eventsPath,
	type HookEvent,
	newHookEvent,
	pendingProposals,
	readHookEvents,
} from "./events.js";
import {
	isSubscriberLive,
	listLiveSubscribers,
	registerSubscriber,
} from "./subscribers.js";
import { findWorkspaceRoot, watchHookEvents } from "./watch.js";
import { applyWordChanges, formatWordDiff, wordChanges } from "./wordDiff.js";

let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hook-"));
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("wordChanges", () => {
	it("merges a removed+added pair into one change", () => {
		const changes = wordChanges("the quick fox", "the slow fox");
		expect(changes).toEqual([
			{ start: 4, end: 9, before: "quick", after: "slow" },
		]);
	});
	it("round-trips through applyWordChanges", () => {
		const a = "One two three. Four five six seven.";
		const b = "One three, and more. Four six seven eight.";
		expect(applyWordChanges(a, wordChanges(a, b))).toBe(b);
	});
	it("formats git-style word diff", () => {
		expect(formatWordDiff("a b c", "a x c")).toBe("a [-b-]{+x+} c");
		expect(formatWordDiff("same", "same")).toBe("");
	});
});

describe("event log", () => {
	it("appends, reads back, and survives a torn tail", async () => {
		await appendHookEvent(
			root,
			newHookEvent("comment.added", "notes/a.md", "user", { text: "hi" }),
		);
		await fs.appendFile(eventsPath(root, "notes/a.md"), '{"broken');
		const events = await readHookEvents(root, "notes/a.md");
		expect(events.map((e) => e.type)).toEqual(["comment.added"]);
		expect(events[0].text).toBe("hi");
	});
	it("rejects unknown types", async () => {
		const bad = {
			...newHookEvent("doc.edited", "a.md", "user"),
			type: "nope",
		} as unknown as HookEvent;
		await expect(appendHookEvent(root, bad)).rejects.toThrow(/Unknown/);
	});
	it("stores hostile text as inert data", async () => {
		const sentinel = "$(echo INJECTED)";
		await appendHookEvent(
			root,
			newHookEvent("comment.added", "a.md", "user", { text: sentinel }),
		);
		const raw = await fs.readFile(eventsPath(root, "a.md"), "utf8");
		expect(raw).toContain("$(echo INJECTED)");
		expect(raw).not.toMatch(/"text":"INJECTED"/);
	});
	it("pendingProposals drops settled ones", () => {
		const events = [
			newHookEvent("edit.proposed", "a.md", "agent", {
				proposalId: "p1",
				find: "x",
				replace: "y",
			}),
			newHookEvent("edit.proposed", "a.md", "agent", {
				proposalId: "p2",
				find: "z",
				replace: "w",
			}),
			newHookEvent("suggestion.rejected", "a.md", "user", { proposalId: "p1" }),
		];
		expect(pendingProposals(events).map((p) => p.proposalId)).toEqual(["p2"]);
	});
});

describe("subscribers", () => {
	it("lists live, prunes stale and dead-pid ones", async () => {
		const sub = await registerSubscriber(root, {
			scope: { kind: "file", path: "/x/a.md" },
			name: "Claude",
			machine: "Air",
		});
		expect((await listLiveSubscribers(root)).map((s) => s.name)).toEqual([
			"Claude",
		]);
		const later = new Date(Date.parse(sub.heartbeatAt) + 60_000);
		expect(isSubscriberLive(sub, later)).toBe(false);
		expect(await listLiveSubscribers(root, new Date(), () => false)).toEqual(
			[],
		);
		// pruned from disk
		expect(await listLiveSubscribers(root)).toEqual([]);
	});
});

describe("watchHookEvents", () => {
	it("emits only new events, skipping the agent's own", async () => {
		await fs.mkdir(path.join(root, ".mdly"));
		await appendHookEvent(
			root,
			newHookEvent("comment.added", "a.md", "user", { text: "old" }),
		);
		const seen: HookEvent[] = [];
		const controller = new AbortController();
		const done = watchHookEvents({
			workspaceRoot: root,
			doc: "a.md",
			intervalMs: 10,
			signal: controller.signal,
			onEvent: (e) => seen.push(e),
		});
		await new Promise((r) => setTimeout(r, 30));
		await appendHookEvent(
			root,
			newHookEvent("edit.proposed", "a.md", "agent", { proposalId: "p" }),
		);
		await appendHookEvent(
			root,
			newHookEvent("comment.added", "a.md", "user", { text: "new" }),
		);
		await new Promise((r) => setTimeout(r, 60));
		controller.abort();
		await done;
		expect(seen.map((e) => e.text)).toEqual(["new"]);
	});
	it("finds the workspace root by .mdly", async () => {
		await fs.mkdir(path.join(root, ".mdly"));
		await fs.mkdir(path.join(root, "sub"));
		expect(await findWorkspaceRoot(path.join(root, "sub", "x.md"))).toBe(root);
	});
});
