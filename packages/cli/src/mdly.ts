#!/usr/bin/env node
/**
 * `mdly` — the agent-hook command. Both subcommands speak only stdin/stdout,
 * so they work unchanged over plain `ssh` from another Mac (no TTY, no new
 * network port):
 *
 *   mdly watch <doc.md> [--name Claude] [--machine Air] [--from-start]
 *     One JSON line per event on the doc (comments, "send edits to agent",
 *     suggestion accepted/rejected, tool requests). Registers a "watching"
 *     subscriber the app shows as a badge. Exits when its ssh session dies.
 *
 *   mdly mcp [--app-data <dir>]
 *     A stdio MCP server that relays to the app's loopback MCP endpoint.
 *     `claude mcp add mdly -- ssh <pro-host> mdly mcp`
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import {
	defaultMachineLabel,
	findWorkspaceRoot,
	HEARTBEAT_MS,
	heartbeatSubscriber,
	readSeen,
	registerSubscriber,
	unregisterSubscriber,
	watchHookEvents,
	writeSeen,
} from "@mdly/agent-hook";

export const MDLY_USAGE = [
	"Usage:",
	"  mdly watch <doc.md> [--name <who>] [--machine <where>] [--workspace <dir>] [--from-start]",
	"  mdly mcp [--app-data <dir>]",
];

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

async function runWatch(args: string[]): Promise<number> {
	const docArg = args.find(
		(a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"),
	);
	if (!docArg) {
		console.error(MDLY_USAGE.join("\n"));
		return 2;
	}
	const absoluteDoc = path.resolve(docArg.replace(/^~(?=\/)/, os.homedir()));
	const workspaceRoot =
		flag(args, "--workspace") ?? (await findWorkspaceRoot(absoluteDoc));
	if (!workspaceRoot) {
		console.error(
			`No mdly workspace (.mdly folder) above ${absoluteDoc}; pass --workspace.`,
		);
		return 2;
	}
	const doc = path.relative(workspaceRoot, absoluteDoc);
	// The agent is assumed to have read the doc as it is now; "send edits" diffs against this.
	if ((await readSeen(workspaceRoot, doc)) === null) {
		try {
			await writeSeen(
				workspaceRoot,
				doc,
				await fs.readFile(absoluteDoc, "utf8"),
			);
		} catch {
			// doc missing: diffs start from empty
		}
	}
	const sub = await registerSubscriber(workspaceRoot, {
		doc,
		name: flag(args, "--name") ?? "Agent",
		machine: flag(args, "--machine") ?? defaultMachineLabel(),
	});
	const controller = new AbortController();
	const stop = () => controller.abort();
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
		process.on(signal, stop);
	process.stdout.on("error", stop); // EPIPE: reader is gone
	const initialParent = process.ppid;
	const heartbeat = setInterval(() => {
		// Over ssh without a TTY no SIGHUP arrives; the session shell dying re-parents us to launchd.
		if (initialParent !== 1 && process.ppid === 1) stop();
		void heartbeatSubscriber(workspaceRoot, sub).catch(() => undefined);
	}, HEARTBEAT_MS);
	console.error(
		`watching ${doc} (subscriber ${sub.id}); events follow as JSON lines`,
	);
	try {
		await watchHookEvents({
			workspaceRoot,
			doc,
			fromStart: args.includes("--from-start"),
			signal: controller.signal,
			onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
		});
	} finally {
		clearInterval(heartbeat);
		await unregisterSubscriber(workspaceRoot, sub);
	}
	return 0;
}

export interface McpEndpoint {
	url: string;
	token: string;
}

export function defaultAppDataDir(): string {
	return path.join(os.homedir(), "Library", "Application Support", "mdly");
}

/** Reads the endpoint the running app published plus its bearer token. */
export async function readMcpEndpoint(
	appDataDir: string,
): Promise<McpEndpoint> {
	const read = async (name: string) =>
		JSON.parse(
			await fs.readFile(path.join(appDataDir, name), "utf8"),
		) as Record<string, unknown>;
	let url = "http://127.0.0.1:7331/mcp";
	try {
		const endpoint = await read("agent-mcp-endpoint.json");
		if (typeof endpoint.url === "string") url = endpoint.url;
	} catch {
		// app hasn't published one; use the default port
	}
	const access = await read("agent-access.json");
	if (typeof access.token !== "string")
		throw new Error("No agent token; is agent access on in mdly?");
	return { url, token: access.token };
}

/** Relays one JSON-RPC message; returns the response line(s) to print, or null for notifications. */
export async function relayMcpMessage(
	line: string,
	endpoint: McpEndpoint,
	fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
	let id: unknown = null;
	try {
		id = (JSON.parse(line) as { id?: unknown }).id ?? null;
	} catch {
		return JSON.stringify({
			jsonrpc: "2.0",
			id: null,
			error: { code: -32700, message: "Parse error" },
		});
	}
	try {
		const response = await fetchImpl(endpoint.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${endpoint.token}`,
			},
			body: line,
		});
		const body = (await response.text()).trim();
		if (!body) return null;
		if (!response.ok && id !== null && !body.startsWith("{")) {
			return JSON.stringify({
				jsonrpc: "2.0",
				id,
				error: { code: -32000, message: `mdly ${response.status}: ${body}` },
			});
		}
		return body;
	} catch (error) {
		if (id === null) return null;
		return JSON.stringify({
			jsonrpc: "2.0",
			id,
			error: {
				code: -32000,
				message: `mdly app unreachable (${error instanceof Error ? error.message : String(error)}). Is mdly running with agent access on?`,
			},
		});
	}
}

async function runMcp(args: string[]): Promise<number> {
	const appData = flag(args, "--app-data") ?? defaultAppDataDir();
	const lines = createInterface({ input: process.stdin });
	let queue = Promise.resolve();
	for await (const line of lines) {
		if (!line.trim()) continue;
		// Keep responses in request order.
		queue = queue.then(async () => {
			const endpoint = await readMcpEndpoint(appData).catch((e: Error) => e);
			const out =
				endpoint instanceof Error
					? JSON.stringify({
							jsonrpc: "2.0",
							id: safeId(line),
							error: { code: -32000, message: endpoint.message },
						})
					: await relayMcpMessage(line, endpoint);
			if (out) process.stdout.write(`${out}\n`);
		});
	}
	await queue;
	return 0;
}

function safeId(line: string): unknown {
	try {
		return (JSON.parse(line) as { id?: unknown }).id ?? null;
	} catch {
		return null;
	}
}

export async function runMdly(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	if (command === "watch") return runWatch(rest);
	if (command === "mcp") return runMcp(rest);
	console.error(MDLY_USAGE.join("\n"));
	return command === "--help" || command === "-h" ? 0 : 2;
}

const isEntry = process.argv[1] && /mdly(\.js)?$/.test(process.argv[1]);
if (isEntry) {
	runMdly(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error) => {
			console.error(error instanceof Error ? error.message : error);
			process.exit(1);
		},
	);
}
