import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readHookEvents } from "@mdly/agent-hook";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	emitHookEvent,
	listPendingProposals,
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
});
