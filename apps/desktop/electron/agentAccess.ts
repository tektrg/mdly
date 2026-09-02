/**
 * The "Allow AI agents to read and comment on this workspace" setting —
 * Slice 4 of `docs/plans/local-doc-comments.md`, Plug A.
 *
 * This has to live in the MAIN process, not renderer `localStorage`: the
 * loopback MCP server (`mcpServer.ts`) must decide whether to even start at
 * app boot, before any renderer window exists to hold that state. Persisted
 * to a small JSON file under `app.getPath("userData")` — but every function
 * here takes `userDataDir` as a parameter rather than importing `electron`,
 * mirroring `docHistoryWiring.ts`'s `loadOrCreateActorId`, so this module is
 * testable without a real Electron app.
 *
 * Default is ON: the setting is a way to turn agent access OFF, not an
 * invite the user must accept before it does anything — Slice 4's plan
 * treats "an agent can reach my notes" as the default posture for a tool
 * built to be used by agents.
 */
import fs from "node:fs/promises";
import path from "node:path";

const AGENT_ACCESS_FILE_NAME = "agent-access.json";

interface AgentAccessFile {
	enabled?: unknown;
	token?: unknown;
}

async function readAgentAccessFile(
	userDataDir: string,
): Promise<AgentAccessFile> {
	try {
		const raw = await fs.readFile(
			path.join(userDataDir, AGENT_ACCESS_FILE_NAME),
			"utf8",
		);
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null
			? (parsed as AgentAccessFile)
			: {};
	} catch {
		// Missing or malformed file — every reader below falls back to its own default.
		return {};
	}
}

async function writeAgentAccessFile(
	userDataDir: string,
	patch: AgentAccessFile,
): Promise<void> {
	const existing = await readAgentAccessFile(userDataDir);
	const next = { ...existing, ...patch };
	await fs.mkdir(userDataDir, { recursive: true });
	await fs.writeFile(
		path.join(userDataDir, AGENT_ACCESS_FILE_NAME),
		JSON.stringify(next, null, 2),
	);
}

/** Defaults to `true` (see module comment) when the file is missing, unreadable, or malformed. */
export async function readAgentAccessEnabled(
	userDataDir: string,
): Promise<boolean> {
	const file = await readAgentAccessFile(userDataDir);
	return file.enabled !== false;
}

export async function writeAgentAccessEnabled(
	userDataDir: string,
	enabled: boolean,
): Promise<void> {
	await writeAgentAccessFile(userDataDir, { enabled });
}

/**
 * Loads (or mints once) a per-install bearer token, persisted alongside the
 * on/off setting. This token is the ONLY thing standing between a random
 * local process and the user's notes — see the comment on `mcpServer.ts`'s
 * auth check for why that's an acceptable trust boundary for a loopback-only
 * server, and why it must never be logged or transmitted anywhere but the
 * `claude mcp add` command shown once in Settings.
 */
export async function readOrCreateAgentAccessToken(
	userDataDir: string,
): Promise<string> {
	const file = await readAgentAccessFile(userDataDir);
	if (typeof file.token === "string" && file.token.length > 0) {
		return file.token;
	}
	const token = crypto.randomUUID().replace(/-/g, "");
	await writeAgentAccessFile(userDataDir, { token });
	return token;
}
