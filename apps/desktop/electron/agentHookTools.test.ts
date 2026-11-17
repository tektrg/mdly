import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listLiveSubscribers, writeOpenDocs } from "@mdly/agent-hook";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WATCH_EVENTS_TOOL } from "./agentHookTools";
import { emitHookEvent, resolveHookTarget } from "./agentHookWiring";
import type { AgentToolContext } from "./agentToolContract";

let root: string;
let appData: string;
let ws: string;
beforeEach(async () => {
	root = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "hook-tools-")),
	);
	appData = path.join(root, "appdata");
	ws = path.join(root, "ws");
	await fs.mkdir(path.join(ws, ".mdly"), { recursive: true });
	await fs.writeFile(path.join(ws, "a.md"), "a");
	await fs.writeFile(path.join(ws, "b.md"), "b");
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

function ctx(openDocumentPath: string | null = null): AgentToolContext {
	return {
		grantedRoots: [ws],
		actorId: "t",
		openDocumentPath,
		notifyCommentsChanged: () => {},
		appDataDir: appData,
	};
}

const comment = (doc: string, text: string) =>
	emitHookEvent(
		resolveHookTarget(doc, [ws], appData),
		"comment.added",
		"user",
		{
			text,
		},
	);

type Polled = {
	events: { text: string; path: string; doc: string }[];
	cursor: string;
};
async function poll(input: Record<string, unknown>, c = ctx()) {
	const result = await WATCH_EVENTS_TOOL.execute(input, c);
	expect(result.isError).toBeFalsy();
	return result.structuredContent as unknown as Polled;
}

describe("watch_events MCP tool", () => {
	it("workspace scope returns events of every doc after the cursor, naming each doc", async () => {
		const first = await poll({ scope: "workspace", path: ws, name: "Claude" });
		expect(first.events).toEqual([]);
		await comment(path.join(ws, "a.md"), "on a");
		await comment(path.join(ws, "b.md"), "$(echo INJECTED)");
		const next = await poll({
			scope: "workspace",
			path: ws,
			since: first.cursor,
		});
		expect(next.events.map((e) => [e.text, e.path])).toEqual([
			["on a", path.join(ws, "a.md")],
			["$(echo INJECTED)", path.join(ws, "b.md")],
		]);
		const again = await poll({
			scope: "workspace",
			path: ws,
			since: next.cursor,
		});
		expect(again.events).toEqual([]);
	});

	it("registers a subscriber (badge) with its scope while polling", async () => {
		await poll({ scope: "file", name: "Claude" }, ctx(path.join(ws, "a.md")));
		const subs = await listLiveSubscribers(appData);
		expect(subs.map((s) => [s.name, s.scope])).toEqual([
			["Claude", { kind: "file", path: path.join(ws, "a.md") }],
		]);
		// Polling again refreshes, never duplicates.
		await poll({ scope: "file", name: "Claude" }, ctx(path.join(ws, "a.md")));
		expect(await listLiveSubscribers(appData)).toHaveLength(1);
	});

	it("open scope follows what is open", async () => {
		await writeOpenDocs(appData, [path.join(ws, "b.md")]);
		const first = await poll({ scope: "open" });
		await comment(path.join(ws, "a.md"), "closed doc");
		await comment(path.join(ws, "b.md"), "open doc");
		const next = await poll({ scope: "open", since: first.cursor });
		expect(next.events.map((e) => e.text)).toEqual(["open doc"]);
	});

	it("rejects an unknown scope", async () => {
		const result = await WATCH_EVENTS_TOOL.execute({ scope: "all" }, ctx());
		expect(result.isError).toBe(true);
	});
});
