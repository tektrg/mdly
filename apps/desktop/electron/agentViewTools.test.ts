/**
 * Saved views outside the app R15/R16: the `list_views` / `create_view` agent
 * tools against a real temp workspace (no mocks of the file layer).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sanitizeSavedView } from "@tektrg/table-core";
import { runViewCommand } from "@tektrg/table-core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentToolContext } from "./agentToolContract";
import { AGENT_TOOLS } from "./agentTools";
import { viewsFilePath } from "./workspaceViewsFile";

let ws: string;
let other: string;
beforeEach(async () => {
	ws = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "mdly-agent-views-")),
	);
	other = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "mdly-agent-other-")),
	);
	await fs.mkdir(path.join(ws, "notes/sub"), { recursive: true });
	await fs.mkdir(path.join(other, "notes"), { recursive: true });
});
afterEach(async () => {
	await fs.rm(ws, { recursive: true, force: true });
	await fs.rm(other, { recursive: true, force: true });
});

function ctx(
	roots: string[] = [ws],
	notified: string[] = [],
	openDocumentPath: string | null = null,
): AgentToolContext {
	return {
		grantedRoots: roots,
		actorId: "agent",
		openDocumentPath,
		notifyCommentsChanged: () => {},
		notifyViewsChanged: (root) => notified.push(root),
	};
}

const tool = (name: string) => {
	const found = AGENT_TOOLS.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`${name} not registered`);
	return found;
};

const exists = (p: string) =>
	fs.stat(p).then(
		() => true,
		() => false,
	);

describe("saved-view agent tools (R15)", () => {
	it("registers list_views + create_view next to every comment tool (R16)", () => {
		const names = AGENT_TOOLS.map((t) => t.name);
		for (const name of [
			"list_documents",
			"list_threads",
			"read_thread",
			"create_thread",
			"reply",
			"resolve",
			"reopen",
			"list_views",
			"create_view",
		]) {
			expect(names).toContain(name);
		}
		expect(tool("list_views").annotations?.readOnlyHint).toBe(true);
	});

	it("create_view writes the file, notifies the open app, and list_views returns it (mcp-tool)", async () => {
		const notified: string[] = [];
		const created = await tool("create_view").execute(
			{
				name: "Open notes",
				folders: ["notes"],
				group_by: "status",
				filters: ["status=open"],
			},
			ctx([ws], notified),
		);
		expect(created.isError).toBeUndefined();
		expect(notified).toEqual([ws]);
		const onDisk = JSON.parse(await fs.readFile(viewsFilePath(ws), "utf8"));
		expect(onDisk.views).toHaveLength(1);
		expect(sanitizeSavedView(onDisk.views[0])).toEqual(onDisk.views[0]);

		const listed = await tool("list_views").execute({}, ctx());
		expect(listed.structuredContent?.views).toEqual([
			{
				id: onDisk.views[0].id,
				name: "Open notes",
				folders: ["notes"],
				groupBy: "prop:status",
				filters: [{ fieldId: "prop:status", kind: "is", value: "open" }],
			},
		]);
	});

	it("writes the same record as the CLI command (R8-mcp-tools-unchanged)", async () => {
		const args = { folders: ["notes"], groupBy: "status", filters: ["tag=x"] };
		const mcp = await tool("create_view").execute(
			{
				name: "Same",
				folders: args.folders,
				group_by: args.groupBy,
				filters: args.filters,
			},
			ctx(),
		);
		const cli = await runViewCommand(other, {
			kind: "create",
			name: "Same",
			...args,
		});
		if (!("record" in cli)) throw new Error("cli failed");
		const { id: _a, ...mcpRecord } = mcp.structuredContent?.record as Record<
			string,
			unknown
		>;
		const { id: _b, ...cliRecord } = cli.record;
		expect(mcpRecord).toEqual(cliRecord);
	});

	it("errors are structured, never thrown, and write nothing (EC9, QA12, QA5-c)", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "mdly-outside-"));
		await fs.symlink(outside, path.join(ws, "link"));
		const cases: [Record<string, unknown>, string][] = [
			[{ name: "" }, "invalid_name"],
			[{ name: "Recent" }, "invalid_name"],
			[{ name: "X", folders: ["missing"] }, "invalid_folder"],
			[{ name: "X", folders: ["../x"] }, "invalid_folder"],
			[{ name: "X", folders: [outside] }, "invalid_folder"],
			[{ name: "X", folders: ["link"] }, "invalid_folder"],
			[{ name: "X", filters: ["=v"] }, "invalid_filter"],
			[{ name: "X", folders: "notes" }, "invalid_input"],
			[{ name: "X", workspace: other }, "workspace_not_granted"],
			[{ name: 42 }, "invalid_input"],
		];
		for (const [input, code] of cases) {
			const result = await tool("create_view").execute(input, ctx());
			expect(result.isError, JSON.stringify(input)).toBe(true);
			expect(result.structuredContent?.error).toMatchObject({ code });
		}
		expect(await exists(path.join(ws, ".hubble"))).toBe(false);
		expect(await fs.readdir(outside)).toEqual([]);
		await fs.rm(outside, { recursive: true, force: true });
	});

	it("no granted workspace / ambiguous workspace are structured errors", async () => {
		const none = await tool("list_views").execute({}, ctx([]));
		expect(none.structuredContent?.error).toMatchObject({
			code: "no_workspace",
		});
		const two = await tool("create_view").execute(
			{ name: "X" },
			ctx([ws, other]),
		);
		expect(two.structuredContent?.error).toMatchObject({
			code: "ambiguous_workspace",
		});
		const byOpenDoc = await tool("create_view").execute(
			{ name: "X" },
			ctx([ws, other], [], path.join(other, "notes/a.md")),
		);
		expect(byOpenDoc.isError).toBeUndefined();
		expect(await exists(viewsFilePath(other))).toBe(true);
		expect(await exists(viewsFilePath(ws))).toBe(false);
	});

	it("list_views on a corrupt file reports it and changes nothing", async () => {
		await fs.mkdir(path.join(ws, ".hubble"));
		await fs.writeFile(viewsFilePath(ws), "not json{");
		const result = await tool("list_views").execute({}, ctx());
		expect(result.structuredContent?.error).toMatchObject({ code: "corrupt" });
		expect(await fs.readdir(path.join(ws, ".hubble"))).toEqual(["views.json"]);
	});
});
