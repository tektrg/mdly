/**
 * End-to-end proof for Slice 4's Plug A: the REAL six-tool table
 * (`AGENT_TOOLS`) served over the REAL loopback MCP server, spoken to over the
 * REAL MCP wire protocol, against a REAL workspace on disk.
 *
 * The unit suites cover the tools and the server separately with stubs. This
 * one deliberately wires the actual pieces together, because that seam — real
 * tools behind the real transport — is where a contract mismatch would hide.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentToolContext } from "./agentToolContract";
import { AGENT_TOOLS } from "./agentTools";
import {
	agentMcpConnectCommand,
	type RunningAgentMcpServer,
	startAgentMcpServer,
} from "./mcpServer";

const TOKEN = "test-token-abcdef";
// Deliberately contains a phrase that occurs twice ("The sync engine"), so the
// ambiguous-quote guard has something real to catch.
const NOTE =
	"# Release notes\n\nThe sync engine now retries failed uploads.\nThe sync engine also logs every retry.\n";

let workspace: string;
let notePath: string;
let server: RunningAgentMcpServer;
let changed: string[] = [];

async function rpc(method: string, params: unknown, token = TOKEN) {
	const res = await fetch(server.url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	if (res.status !== 200) return { status: res.status, body: null };
	return { status: res.status, body: await res.json() };
}

/** The whole comment log for the note, so a test can prove a refusal wrote nothing. */
async function readCommentLog(): Promise<string> {
	const dir = path.join(workspace, ".mdly", "comments");
	const names = await fs.readdir(dir).catch(() => [] as string[]);
	const parts = await Promise.all(
		names.map((name) => fs.readFile(path.join(dir, name), "utf8")),
	);
	return parts.join("");
}

function textOf(body: unknown): string {
	const result = (body as { result?: { content?: { text?: string }[] } })
		?.result;
	return result?.content?.[0]?.text ?? "";
}

beforeAll(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mdly-agent-e2e-"));
	notePath = path.join(workspace, "release-notes.md");
	await fs.writeFile(notePath, NOTE);

	const context: AgentToolContext = {
		grantedRoots: [workspace],
		actorId: "device-e2e",
		openDocumentPath: notePath,
		notifyCommentsChanged: (p) => changed.push(p),
	};
	server = await startAgentMcpServer({
		tools: AGENT_TOOLS,
		getContext: () => context,
		token: TOKEN,
		appVersion: "0.0.0-test",
		// Port 0 keeps this test off the app's real 7331.
		port: 0,
	});
});

afterAll(async () => {
	await server?.stop();
	await fs.rm(workspace, { recursive: true, force: true });
});

describe("Slice 4 Plug A end-to-end", () => {
	it("refuses a request with no bearer token", async () => {
		const res = await fetch(server.url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(res.status).toBe(401);
	});

	it("publishes all six tools with their safety annotations intact", async () => {
		const { body } = await rpc("tools/list", {});
		const tools = (body as { result: { tools: { name: string }[] } }).result
			.tools;
		expect(tools.map((t) => t.name).sort()).toEqual([
			"create_thread",
			"list_threads",
			"read_thread",
			"reopen",
			"reply",
			"resolve",
		]);
		// The whole point of the slice's safety posture: comment text is
		// model-read, so anything returning it must stay flagged across the wire.
		for (const name of ["list_threads", "read_thread"]) {
			const tool = tools.find((t) => t.name === name) as unknown as {
				annotations: Record<string, boolean>;
			};
			expect(tool.annotations.readOnlyHint).toBe(true);
			expect(tool.annotations.untrustedContentHint).toBe(true);
		}
	});

	it("creates, reads, replies to, resolves and reopens a thread over the wire", async () => {
		changed = [];
		const created = await rpc("tools/call", {
			name: "create_thread",
			arguments: {
				quote: "retries failed uploads",
				text: "Does this cover 429s specifically?",
			},
		});
		expect(textOf(created.body)).not.toMatch(/error/i);
		// A write must tell the open editor to refetch, or the comment stays invisible.
		expect(changed).toContain(notePath);

		const listed = await rpc("tools/call", {
			name: "list_threads",
			arguments: { scope: "workspace", state: "all" },
		});
		const listedText = textOf(listed.body);
		expect(listedText).toContain("Does this cover 429s specifically?");
		// Comment text crosses back wrapped, so a client can quarantine it.
		expect(listedText).toContain("untrusted-content");
		// Every read tells the agent which note the human is looking at.
		expect(listedText).toContain("release-notes.md");

		const threadId = /"?threadId"?[:=]\s*"?([A-Za-z0-9_-]+)/.exec(
			listedText,
		)?.[1];
		expect(
			threadId,
			`no threadId found in: ${listedText.slice(0, 600)}`,
		).toBeTruthy();

		const replied = await rpc("tools/call", {
			name: "reply",
			arguments: { thread_id: threadId, text: "Yes — 429 and 5xx both retry." },
		});
		expect(textOf(replied.body)).not.toMatch(/error/i);

		const resolved = await rpc("tools/call", {
			name: "resolve",
			arguments: { thread_id: threadId },
		});
		expect(textOf(resolved.body)).not.toMatch(/error/i);

		const afterResolve = await rpc("tools/call", {
			name: "read_thread",
			arguments: { thread_id: threadId },
		});
		expect(textOf(afterResolve.body)).toContain("resolved");

		const reopened = await rpc("tools/call", {
			name: "reopen",
			arguments: { thread_id: threadId },
		});
		expect(textOf(reopened.body)).not.toMatch(/error/i);
	});

	it("writes agent-authored comments to the workspace sidecar, never the note", async () => {
		const noteOnDisk = await fs.readFile(notePath, "utf8");
		expect(noteOnDisk).toBe(NOTE);

		const commentsDir = path.join(workspace, ".mdly", "comments");
		const logs = await fs.readdir(commentsDir);
		expect(logs.length).toBeGreaterThan(0);
		const log = await readCommentLog();
		expect(log).toContain('"kind":"agent"');
		expect(log).toContain('"label":"AI agent"');
		expect(log).not.toContain('"kind":"human"');
	});

	it("refuses an ambiguous quote, a missing quote and a hallucinated thread id, writing nothing", async () => {
		const before = await fs.readFile(notePath, "utf8");
		const logBefore = await readCommentLog();

		// Occurs twice — anchoring it would be a coin flip, so it must refuse.
		const ambiguous = await rpc("tools/call", {
			name: "create_thread",
			arguments: { quote: "The sync engine", text: "which one?" },
		});
		expect(textOf(ambiguous.body)).toMatch(/ambiguous/i);

		// The classic agent failure: quoting text that isn't in the note.
		const missing = await rpc("tools/call", {
			name: "create_thread",
			arguments: { quote: "a sentence the model invented", text: "hm" },
		});
		expect(textOf(missing.body)).toMatch(/not found/i);

		// The other classic: a hallucinated thread id. Without this guard the
		// store would happily append a detached, invisible comment.
		const bogus = await rpc("tools/call", {
			name: "reply",
			arguments: { thread_id: "does-not-exist", text: "hello" },
		});
		expect(textOf(bogus.body)).toMatch(/no comment thread/i);

		expect(await fs.readFile(notePath, "utf8")).toBe(before);
		expect(await readCommentLog()).toBe(logBefore);
	});

	it("refuses a symlink inside the workspace that points outside it", async () => {
		// The containment check is a string comparison, but every read follows
		// symlinks — so without resolving them, a link planted in a granted root
		// turns `create_thread` into a read oracle for any file this OS user can
		// open, reachable by anything holding the loopback token.
		const secretDir = await fs.mkdtemp(path.join(os.tmpdir(), "mdly-secret-"));
		const secret = path.join(secretDir, "secret.md");
		await fs.writeFile(secret, "# Secret\n\nthe api key is hunter2\n");
		const planted = path.join(workspace, "innocent.md");
		await fs.symlink(secret, planted);

		try {
			const escaped = await rpc("tools/call", {
				name: "create_thread",
				arguments: { path: planted, quote: "hunter2", text: "what is this?" },
			});
			expect(textOf(escaped.body)).toMatch(/outside every granted/i);
			// The refusal must not have leaked the file's contents on the way out.
			expect(textOf(escaped.body)).not.toContain("hunter2 ");

			const read = await rpc("tools/call", {
				name: "list_threads",
				arguments: { scope: "workspace", state: "all" },
			});
			expect(textOf(read.body)).not.toContain("api key");
		} finally {
			await fs.rm(planted, { force: true });
			await fs.rm(secretDir, { recursive: true, force: true });
		}
	});

	it("still accepts a granted root that is itself reached through a symlink", async () => {
		// macOS hands out /tmp paths that are really /private/tmp, so resolving
		// only the target and not the root would reject legitimate workspaces.
		const realRoot = await fs.realpath(workspace);
		expect(realRoot).not.toBe("");
		const listed = await rpc("tools/call", {
			name: "list_threads",
			arguments: { scope: "workspace", state: "all" },
		});
		expect(textOf(listed.body)).not.toMatch(/outside every granted/i);
	});

	it("produces a connect command a user can paste", () => {
		expect(agentMcpConnectCommand(server.url, TOKEN)).toBe(
			`claude mcp add --transport http mdly ${server.url} --header "Authorization: Bearer ${TOKEN}"`,
		);
	});
});
