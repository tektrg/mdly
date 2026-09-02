import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAgentAccessEnabled, writeAgentAccessEnabled } from "./agentAccess";
import type { AgentTool, AgentToolContext } from "./agentToolContract";
import { textResult } from "./agentToolContract";
import {
	agentMcpConnectCommand,
	type RunningAgentMcpServer,
	startAgentMcpServer,
} from "./mcpServer";

const TOKEN = "test-token-abc123";
const APP_VERSION = "1.2.3";

/** Minimal MCP JSON-RPC client just for these tests — real clients (Claude Code) speak the same wire protocol. */
async function callMcp(
	server: RunningAgentMcpServer,
	body: Record<string, unknown>,
	authHeader?: string,
): Promise<Response> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
	};
	if (authHeader !== undefined) headers.authorization = authHeader;
	return fetch(server.url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

function listToolsRequest() {
	return { jsonrpc: "2.0", id: 1, method: "tools/list" };
}

function callToolRequest(name: string, args: Record<string, unknown> = {}) {
	return {
		jsonrpc: "2.0",
		id: 2,
		method: "tools/call",
		params: { name, arguments: args },
	};
}

function stubContext(): AgentToolContext {
	return {
		grantedRoots: ["/tmp/workspace"],
		actorId: "device-1",
		openDocumentPath: null,
		notifyCommentsChanged: () => {},
	};
}

function makeStubTools(): AgentTool[] {
	const readTool: AgentTool = {
		name: "read-note",
		description: "Reads a note.",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		execute: async () => textResult("stub read result"),
	};
	const writeTool: AgentTool = {
		name: "write-comment",
		description: "Writes a comment.",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
		},
		annotations: {},
		execute: async (input) => textResult(`wrote: ${String(input.text ?? "")}`),
	};
	return [readTool, writeTool];
}

let servers: RunningAgentMcpServer[] = [];

async function startTestServer(
	overrides: Partial<{
		tools: AgentTool[];
		getContext: () => AgentToolContext;
	}> = {},
): Promise<{
	server: RunningAgentMcpServer;
	getContext: ReturnType<typeof vi.fn>;
}> {
	const getContext = vi.fn(overrides.getContext ?? stubContext);
	const server = await startAgentMcpServer({
		tools: overrides.tools ?? makeStubTools(),
		getContext,
		token: TOKEN,
		appVersion: APP_VERSION,
		port: 0, // OS-assigned — never fight the real app (or other test files) for 7331.
	});
	servers.push(server);
	return { server, getContext };
}

afterEach(async () => {
	await Promise.all(servers.map((server) => server.stop()));
	servers = [];
	vi.restoreAllMocks();
});

describe("startAgentMcpServer", () => {
	it("binds to loopback only and rejects a request with no bearer token (401)", async () => {
		const { server } = await startTestServer();
		expect(server.url.startsWith("http://127.0.0.1:")).toBe(true);

		const res = await callMcp(server, listToolsRequest());
		expect(res.status).toBe(401);
	});

	it("rejects a request with the wrong bearer token (401)", async () => {
		const { server } = await startTestServer();
		const res = await callMcp(server, listToolsRequest(), "Bearer wrong-token");
		expect(res.status).toBe(401);
	});

	it("tools/list returns every injected tool with annotations (readOnlyHint + untrustedContentHint) intact", async () => {
		const { server } = await startTestServer();

		const res = await callMcp(server, listToolsRequest(), `Bearer ${TOKEN}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result: { tools: Array<Record<string, unknown>> };
		};

		expect(body.result.tools).toHaveLength(2);
		const readTool = body.result.tools.find((t) => t.name === "read-note");
		expect(readTool).toBeDefined();
		// The regression guard that matters most: a read tool must never lose
		// these hints on the way to the wire — a client that can't see
		// `untrustedContentHint` has no way to quarantine comment/document text.
		expect(readTool?.annotations).toMatchObject({
			readOnlyHint: true,
			untrustedContentHint: true,
		});

		const writeTool = body.result.tools.find((t) => t.name === "write-comment");
		expect(writeTool?.inputSchema).toMatchObject({
			type: "object",
			required: ["text"],
		});
	});

	it("tools/call invokes the named tool and returns its result", async () => {
		const { server } = await startTestServer();

		const res = await callMcp(
			server,
			callToolRequest("write-comment", { text: "why bold?" }),
			`Bearer ${TOKEN}`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result: { content: Array<{ type: string; text: string }> };
		};
		expect(body.result.content[0]?.text).toBe("wrote: why bold?");
	});

	it("calls getContext fresh per tool invocation, not once at server start", async () => {
		const { server, getContext } = await startTestServer();
		expect(getContext).not.toHaveBeenCalled();

		await callMcp(server, callToolRequest("read-note"), `Bearer ${TOKEN}`);
		await callMcp(server, callToolRequest("read-note"), `Bearer ${TOKEN}`);

		expect(getContext).toHaveBeenCalledTimes(2);
	});

	it("stop() is idempotent", async () => {
		const { server } = await startTestServer();
		await server.stop();
		await expect(server.stop()).resolves.toBeUndefined();
	});

	it("produces the documented one-line claude mcp add command", () => {
		const command = agentMcpConnectCommand(
			"http://127.0.0.1:7331/mcp",
			"abc123",
		);
		expect(command).toBe(
			'claude mcp add --transport http mdly http://127.0.0.1:7331/mcp --header "Authorization: Bearer abc123"',
		);
	});
});

describe("agentAccess", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-access-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("defaults to enabled when no settings file exists yet", async () => {
		expect(await readAgentAccessEnabled(tmpDir)).toBe(true);
	});

	it("round-trips a disabled setting", async () => {
		await writeAgentAccessEnabled(tmpDir, false);
		expect(await readAgentAccessEnabled(tmpDir)).toBe(false);

		await writeAgentAccessEnabled(tmpDir, true);
		expect(await readAgentAccessEnabled(tmpDir)).toBe(true);
	});
});
