/**
 * The loopback MCP server — Slice 4 of `docs/plans/local-doc-comments.md`,
 * Plug A: "Claude Code reaches the app's document-comment tools with one
 * `claude mcp add` line and no relay process."
 *
 * This is a thin adapter, per `agentToolContract.ts`'s standing instruction:
 * it republishes whatever `AgentTool[]` it's handed (`toDescriptor` for
 * `tools/list`, `execute` for `tools/call`) and owns no tool logic itself.
 * `tools`/`getContext` are injected rather than imported at module load, so
 * this file never depends on `agentTools.ts` (written concurrently by
 * another session) and stays testable with a stub tool array.
 *
 * SECURITY: this server binds to 127.0.0.1 ONLY and never 0.0.0.0. Even so,
 * loopback is not private — every other process running as this OS user
 * (any app, any script, any other agent) can open a TCP connection to a
 * loopback port. The bearer token is the ONLY thing standing between a
 * random local program and the ability to read and comment on the user's
 * notes. Every request is rejected with 401 unless it carries
 * `Authorization: Bearer <token>`, checked in constant time so a timing
 * attack can't shave the token down a byte at a time.
 *
 * Transport: MCP's Streamable HTTP over plain `node:http` (no Express — the
 * SDK's `StreamableHTTPServerTransport` speaks `IncomingMessage`/
 * `ServerResponse` directly). Run in STATELESS mode
 * (`sessionIdGenerator: undefined`): a fresh low-level `Server` + transport
 * pair is created per request and torn down when the response closes. This
 * is the SDK's own documented pattern for a stateless HTTP server, and it
 * sidesteps session bookkeeping entirely — appropriate here since every
 * request re-reads `getContext()` anyway (mdly has no notion of an MCP
 * "session" independent of "the app's current state").
 *
 * `enableJsonResponse: true` is passed to the transport so each POST gets a
 * plain `application/json` response instead of opening an SSE stream — this
 * server never needs server-initiated messages mid-request (no sampling, no
 * elicitation), so there's nothing an SSE stream would buy here, and a plain
 * response is simpler for both this file and its tests.
 *
 * The low-level `Server` (not the high-level `McpServer`) is used
 * deliberately: `McpServer.registerTool` wants a Zod (or Standard Schema)
 * input schema, but `AgentToolDescriptor.inputSchema` is already plain JSON
 * Schema — the wire format `tools/list` sends verbatim. Handling
 * `ListToolsRequestSchema`/`CallToolRequestSchema` directly means each
 * descriptor's `annotations` (including the non-standard
 * `untrustedContentHint`) reaches the wire completely unmodified: the SDK
 * only re-validates/re-serializes the RESULT of `tools/call` against
 * `CallToolResultSchema`, never the `tools/list` response, so nothing here
 * risks a validator silently stripping a hint it doesn't recognize.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	type CallToolResult,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
	type AgentTool,
	type AgentToolContext,
	type AgentToolResult,
	errorResult,
	toDescriptor,
} from "./agentToolContract";

/** Fixed, memorable default (per the plan); falls back to an OS-assigned free port if it's taken (never crashes the app over a busy port). */
export const DEFAULT_AGENT_MCP_PORT = 7331;

const LOOPBACK_HOST = "127.0.0.1";
const MCP_PATH = "/mcp";
const SERVER_NAME = "mdly";

export interface StartAgentMcpServerOptions {
	tools: AgentTool[];
	/** Called once PER tool invocation — never snapshotted at boot — so `openDocumentPath`/`grantedRoots` are always current. */
	getContext: () => AgentToolContext;
	/** Per-install bearer token; see the module comment for why this is the only access control. */
	token: string;
	/** Preferred port; defaults to `DEFAULT_AGENT_MCP_PORT` and falls back to an OS-assigned one if busy. */
	port?: number;
	/** The desktop app's version, published as the MCP server's `Implementation.version`. */
	appVersion: string;
}

export interface RunningAgentMcpServer {
	/** The full endpoint URL a client should connect to (`http://127.0.0.1:<port>/mcp`), reflecting whatever port was actually bound. */
	url: string;
	port: number;
	/** Closes the listener. Safe to call more than once. */
	stop: () => Promise<void>;
}

/** Constant-time bearer check — a naive `===` would let a timing attack recover the token one byte at a time. */
function isAuthorized(req: IncomingMessage, token: string): boolean {
	const header = req.headers.authorization;
	if (typeof header !== "string") return false;
	const expected = `Bearer ${token}`;
	const actual = Buffer.from(header);
	const expectedBuffer = Buffer.from(expected);
	if (actual.length !== expectedBuffer.length) return false;
	return timingSafeEqual(actual, expectedBuffer);
}

/**
 * `AgentToolResult` (from `agentToolContract.ts`) is a plain interface —
 * deliberately not a Zod type, so the tool contract has no SDK dependency —
 * while the SDK's `CallToolResult` is Zod-inferred and therefore carries a
 * `[x: string]: unknown` index signature. The two are structurally
 * identical on every field either type names; this cast is the one place
 * that difference is bridged, rather than leaking an SDK type into the
 * contract module.
 */
function toCallToolResult(result: AgentToolResult): CallToolResult {
	return result as CallToolResult;
}

/**
 * Builds one request-scoped low-level `Server`, wired to republish `tools`
 * and dispatch calls through `execute`. A fresh instance per HTTP request
 * (see module comment on statelessness) — cheap, since this only registers
 * two request handlers over closures.
 */
function createRequestScopedMcpServer(
	tools: AgentTool[],
	getContext: () => AgentToolContext,
	appVersion: string,
): Server {
	const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

	const server = new Server(
		{ name: SERVER_NAME, version: appVersion },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => {
		return { tools: tools.map(toDescriptor) };
	});

	server.setRequestHandler(
		CallToolRequestSchema,
		async (request): Promise<CallToolResult> => {
			const tool = toolsByName.get(request.params.name);
			if (!tool) {
				return toCallToolResult(
					errorResult(`Unknown tool: ${request.params.name}`),
				);
			}
			try {
				return toCallToolResult(
					await tool.execute(request.params.arguments ?? {}, getContext()),
				);
			} catch (error) {
				return toCallToolResult(
					errorResult(error instanceof Error ? error.message : String(error)),
				);
			}
		},
	);

	return server;
}

/** Binds `server` to `host`/`preferredPort`; on `EADDRINUSE` falls back to an OS-assigned free port instead of throwing, so a busy 7331 never crashes the app. Resolves with the port actually bound. */
function listenOnLoopback(
	server: http.Server,
	preferredPort: number,
	host: string,
): Promise<number> {
	return new Promise((resolve, reject) => {
		const onceListening = () => {
			const address = server.address();
			resolve(
				typeof address === "object" && address !== null
					? address.port
					: preferredPort,
			);
		};
		const onFirstError = (error: NodeJS.ErrnoException) => {
			server.removeListener("listening", onceListening);
			if (error.code !== "EADDRINUSE") {
				reject(error);
				return;
			}
			server.once("listening", onceListening);
			server.once("error", reject);
			server.listen(0, host);
		};
		server.once("error", onFirstError);
		server.once("listening", () => {
			server.removeListener("error", onFirstError);
			onceListening();
		});
		server.listen(preferredPort, host);
	});
}

/**
 * Starts the loopback MCP server. Never throws over a busy default port
 * (falls back to an OS-assigned one instead); any other bind failure (e.g. a
 * genuinely invalid host) rejects, since that's not recoverable by retrying.
 */
export async function startAgentMcpServer(
	options: StartAgentMcpServerOptions,
): Promise<RunningAgentMcpServer> {
	const { tools, getContext, token, appVersion } = options;
	const preferredPort = options.port ?? DEFAULT_AGENT_MCP_PORT;

	const httpServer = http.createServer((req, res) => {
		if (req.url !== MCP_PATH) {
			res.writeHead(404).end();
			return;
		}
		if (!isAuthorized(req, token)) {
			res
				.writeHead(401, { "content-type": "application/json" })
				.end(JSON.stringify({ error: "Unauthorized" }));
			return;
		}

		const mcpServer = createRequestScopedMcpServer(
			tools,
			getContext,
			appVersion,
		);
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		// Teardown must never turn into an unhandled rejection that takes the
		// whole main process down; a failed close is already best-effort.
		res.on("close", () => {
			transport.close().catch(() => {});
			mcpServer.close().catch(() => {});
		});

		void mcpServer
			.connect(transport)
			.then(() => transport.handleRequest(req, res))
			.catch((error: unknown) => {
				console.error("[agent-mcp] request handling failed:", error);
				if (!res.headersSent) {
					res
						.writeHead(500, { "content-type": "application/json" })
						.end(JSON.stringify({ error: "Internal server error" }));
				}
			});
	});

	// Binding explicitly to 127.0.0.1 — see module comment. Never "0.0.0.0" or
	// an unspecified host, which would expose this to the local network.
	const port = await listenOnLoopback(httpServer, preferredPort, LOOPBACK_HOST);

	let stopped = false;
	return {
		url: `http://${LOOPBACK_HOST}:${port}${MCP_PATH}`,
		port,
		async stop() {
			if (stopped) return;
			stopped = true;
			await new Promise<void>((resolve, reject) => {
				httpServer.close((error) => (error ? reject(error) : resolve()));
			});
		},
	};
}

/**
 * The one-line command the Settings UI shows so a user can copy-paste their
 * way to a working connection, no relay process involved. `--transport http`
 * plus a `--header` flag is the current `claude mcp add` syntax for a remote
 * HTTP server with a custom auth header (verified against Claude Code's own
 * docs/CLI help — see the Plug A handoff report for how).
 */
export function agentMcpConnectCommand(url: string, token: string): string {
	return `claude mcp add --transport http ${SERVER_NAME} ${url} --header "Authorization: Bearer ${token}"`;
}

/** Re-exported so callers (Settings UI, tests) can mint a token without importing `node:crypto` themselves. */
export function createAgentMcpToken(): string {
	return randomUUID().replace(/-/g, "");
}
