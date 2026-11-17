import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	readHookEvents,
	readOpenDocs,
	registerSubscriber,
} from "@mdly/agent-hook";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createOpenDocsTracker,
	emitDecision,
	emitHookEvent,
	listPendingProposals,
	listWatchers,
	proposeEdit,
	resolveHookTarget,
	sendEditsToAgent,
} from "./agentHookWiring";

let root: string;
beforeEach(async () => {
	root = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "hook-wiring-")),
	);
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("agent hook wiring", () => {
	it("send edits: word diff vs last-seen, then nothing on a second send", async () => {
		const target = resolveHookTarget(path.join(root, "n", "a.md"), [root]);
		expect(target.doc).toBe(path.join("n", "a.md"));
		expect(await sendEditsToAgent(target, "the quick fox")).toEqual({
			status: "sent",
			changes: 1,
		});
		expect(await sendEditsToAgent(target, "the slow fox")).toEqual({
			status: "sent",
			changes: 1,
		});
		expect(await sendEditsToAgent(target, "the slow fox")).toEqual({
			status: "unchanged",
		});
		const events = await readHookEvents(root, target.doc);
		expect(events.map((e) => e.diff)).toEqual([
			"{+the quick fox+}",
			"the [-quick-]{+slow+} fox",
		]);
	});

	it("proposals stay pending until accepted/rejected", async () => {
		const target = resolveHookTarget(path.join(root, "a.md"), [root]);
		const p = await proposeEdit(target, {
			find: "a",
			replace: "b",
			author: "AI agent",
		});
		expect(
			(await listPendingProposals(target)).map((x) => x.proposalId),
		).toEqual([p.proposalId]);
		await emitHookEvent(target, "suggestion.accepted", "user", {
			proposalId: p.proposalId,
		});
		expect(await listPendingProposals(target)).toEqual([]);
		await expect(
			proposeEdit(target, { find: "", replace: "x", author: "a" }),
		).rejects.toThrow();
	});

	it("refuses paths outside granted roots", () => {
		expect(() => resolveHookTarget("/elsewhere/a.md", [root])).toThrow(
			/granted/,
		);
	});

	it("rejects a find that matches several places unless an occurrence is given", async () => {
		await fs.writeFile(path.join(root, "d.md"), "the cat\n\nthe cat sat\n");
		const target = resolveHookTarget(path.join(root, "d.md"), [root]);
		await expect(
			proposeEdit(target, { find: "the cat", replace: "a dog", author: "a" }),
		).rejects.toThrow(/2 places.*occurrence/);
		await expect(
			proposeEdit(target, {
				find: "the cat",
				replace: "a dog",
				author: "a",
				occurrence: 3,
			}),
		).rejects.toThrow(/only 2/);
		const ok = await proposeEdit(target, {
			find: "the cat",
			replace: "a dog",
			author: "a",
			occurrence: 2,
		});
		expect(ok.occurrence).toBe(2);
		expect((await listPendingProposals(target))[0].occurrence).toBe(2);
		await expect(
			proposeEdit(target, {
				find: "cat sat",
				replace: "dog sat",
				author: "a",
				occurrence: 0,
			}),
		).rejects.toThrow(/occurrence/);
	});

	it("records all / some / none accepted as distinct outcomes with counts", async () => {
		const target = resolveHookTarget(path.join(root, "o.md"), [root]);
		await emitDecision(target, {
			proposalId: "a",
			source: "agent",
			accepted: 3,
			rejected: 0,
		});
		await emitDecision(target, {
			proposalId: "b",
			source: "agent",
			accepted: 1,
			rejected: 2,
		});
		await emitDecision(target, {
			proposalId: "c",
			source: "agent",
			accepted: 0,
			rejected: 2,
		});
		const events = await readHookEvents(root, target.doc);
		expect(
			events.map((e) => [e.type, e.acceptedChanges, e.rejectedChanges]),
		).toEqual([
			["suggestion.accepted", 3, 0],
			["suggestion.partially_accepted", 1, 2],
			["suggestion.rejected", 0, 2],
		]);
	});

	it("a standalone file (no .mdly above it) streams to app data, not next to the file", async () => {
		const appData = path.join(root, "appdata");
		const loose = path.join(root, "loose", "n.md");
		const target = resolveHookTarget(loose, [path.dirname(loose)], appData);
		expect(target.workspaceRoot.startsWith(appData)).toBe(true);
		expect(target.path).toBe(loose);
		await emitHookEvent(target, "comment.added", "user", { text: "x" });
		await expect(fs.stat(path.join(root, "loose", ".mdly"))).rejects.toThrow();
		// A doc inside a workspace keeps its workspace stream.
		await fs.mkdir(path.join(root, "ws", ".mdly"), { recursive: true });
		const inWs = resolveHookTarget(
			path.join(root, "ws", "a.md"),
			[root],
			appData,
		);
		expect(inWs).toMatchObject({
			workspaceRoot: path.join(root, "ws"),
			doc: "a.md",
		});
	});

	it("badge: watchers whose scope covers the doc (file, workspace, open)", async () => {
		const appData = path.join(root, "appdata");
		await fs.mkdir(path.join(root, "ws", ".mdly"), { recursive: true });
		const a = path.join(root, "ws", "a.md");
		const b = path.join(root, "b.md");
		await registerSubscriber(appData, {
			scope: { kind: "workspace", root: path.join(root, "ws") },
			name: "W",
			machine: "m",
		});
		await registerSubscriber(appData, {
			scope: { kind: "open" },
			name: "O",
			machine: "m",
		});
		const tracker = createOpenDocsTracker(appData);
		await tracker.open(1, b);
		const names = async (doc: string) =>
			(
				await listWatchers(
					resolveHookTarget(doc, [root], appData),
					appData,
					tracker.list(),
				)
			)
				.map((w) => w.name)
				.sort();
		expect(await names(a)).toEqual(["W"]);
		expect(await names(b)).toEqual(["O"]);
		await tracker.closeOwner(1);
		expect(await names(b)).toEqual([]);
	});

	it("open docs: published per window, a doc open twice stays open until both close", async () => {
		const appData = path.join(root, "appdata");
		const tracker = createOpenDocsTracker(appData);
		const a = path.join(root, "a.md");
		await tracker.open(1, a);
		await tracker.open(2, a);
		await tracker.close(1, a);
		expect(await readOpenDocs(appData)).toEqual([a]);
		await tracker.closeOwner(2);
		expect(await readOpenDocs(appData)).toEqual([]);
	});
});
