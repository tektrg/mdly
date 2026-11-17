/**
 * Agent-hook write-back tools. An agent never overwrites a note: `propose_edit`
 * records a suggestion the human reviews inline (accept/reject). Replying to
 * and resolving comments reuse the existing `reply`/`resolve` tools.
 */
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
	readScopeEvents,
	resolveDocStore,
	upsertSubscriber,
	type WatchScope,
} from "@mdly/agent-hook";
import { resolveAgentPath } from "./agentComments";
import {
	listPendingProposals,
	proposeEdit,
	resolveHookTarget,
} from "./agentHookWiring";
import {
	AGENT_AUTHOR_LABEL,
	type AgentTool,
	type AgentToolContext,
	errorResult,
	textResult,
} from "./agentToolContract";

function str(
	input: Record<string, unknown>,
	key: string,
	required: boolean,
): string | undefined {
	const value = input[key];
	if (value === undefined || value === null) {
		if (required) throw new Error(`"${key}" is required.`);
		return undefined;
	}
	if (typeof value !== "string") throw new Error(`"${key}" must be a string.`);
	return value;
}

function num(input: Record<string, unknown>, key: string): number | undefined {
	const value = input[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number") throw new Error(`"${key}" must be a number.`);
	return value;
}

export const PROPOSE_EDIT_TOOL: AgentTool = {
	name: "propose_edit",
	description:
		"Proposes an edit to a note as a suggestion the human accepts or rejects inline (red strike-through / green insert). Never changes the file directly. `find` must be exact visible text from ONE paragraph (rendered text, no Markdown syntax) and must be unique in the note, or name which match with `occurrence`; an ambiguous or unmatched `find` is rejected (the outcome arrives as suggestion.rejected with a `reason`). `replace` is plain text. `path` defaults to the open note. Watch the outcome with `mdly watch`: suggestion.accepted (all changes taken), suggestion.partially_accepted (some; see acceptedChanges/rejectedChanges) or suggestion.rejected.",
	inputSchema: {
		type: "object",
		properties: {
			path: {
				type: "string",
				description:
					"Note path, relative to the workspace root or absolute. Defaults to the open note.",
			},
			find: {
				type: "string",
				description: "Exact visible text to replace, within one paragraph.",
			},
			replace: { type: "string", description: "Replacement text (plain)." },
			occurrence: {
				type: "integer",
				minimum: 1,
				description:
					"Which match of `find` to replace (1-based, in document order). Required when `find` appears more than once; otherwise the proposal is rejected as ambiguous.",
			},
			note: {
				type: "string",
				description: "Optional one-line reason shown to the human.",
			},
		},
		required: ["find", "replace"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: false },
	async execute(input, ctx) {
		try {
			const { absolutePath } = await resolveAgentPath(
				str(input, "path", false),
				ctx,
			);
			const target = resolveHookTarget(
				absolutePath,
				ctx.grantedRoots,
				ctx.appDataDir,
			);
			const proposal = await proposeEdit(target, {
				find: str(input, "find", true) ?? "",
				replace: str(input, "replace", true) ?? "",
				note: str(input, "note", false),
				occurrence: num(input, "occurrence"),
				author: AGENT_AUTHOR_LABEL,
			});
			ctx.notifySuggestionsChanged?.(absolutePath);
			const pending = await listPendingProposals(target);
			return textResult(
				`Proposed as suggestion "${proposal.proposalId}" (${pending.length} pending on this note). The human will accept or reject it.`,
				{ proposalId: proposal.proposalId },
			);
		} catch (error) {
			return errorResult(
				error instanceof Error ? error.message : String(error),
			);
		}
	},
};

async function resolveScope(
	input: Record<string, unknown>,
	ctx: AgentToolContext,
): Promise<WatchScope> {
	const kind = str(input, "scope", true);
	const given = str(input, "path", false);
	if (kind === "open") return { kind: "open" };
	if (kind === "file") {
		const { absolutePath } = await resolveAgentPath(given, ctx);
		return { kind: "file", path: absolutePath };
	}
	if (kind === "workspace") {
		if (given) {
			const { absolutePath } = await resolveAgentPath(given, ctx);
			return { kind: "workspace", root: absolutePath };
		}
		const { absolutePath, workspaceRoot } = await resolveAgentPath(
			undefined,
			ctx,
		);
		// The open note's `.mdly` workspace; a standalone note falls back to its granted folder.
		const store = ctx.appDataDir
			? resolveDocStore(absolutePath, ctx.appDataDir)
			: null;
		return {
			kind: "workspace",
			root:
				store && !path.isAbsolute(store.doc)
					? store.workspaceRoot
					: workspaceRoot,
		};
	}
	throw new Error('"scope" must be "file", "open" or "workspace".');
}

/** Stable id per (name, scope), so each poll refreshes one badge instead of adding one. */
function pollerId(name: string, scope: WatchScope): string {
	return `mcp-${createHash("sha256")
		.update(`${name}\0${JSON.stringify(scope)}`)
		.digest("hex")
		.slice(0, 12)}`;
}

export const WATCH_EVENTS_TOOL: AgentTool = {
	name: "watch_events",
	description:
		'Subscribe to the agent-hook event stream over MCP (the poll form of `mdly watch`). `scope`: "file" (one note, `path` or the open note; a standalone file works too), "workspace" (every note in the folder `path`, default the open note\'s workspace), or "open" (whatever is open in mdly, following opens/closes). The first call returns no events and a `cursor`; call again with `since` = that cursor to get what happened since (comments, "send edits to agent", suggestion outcomes, tool requests). Each event names its note (`doc`, absolute `path`). Polling at least every 30s shows a "watching" badge on every note in scope.',
	inputSchema: {
		type: "object",
		properties: {
			scope: { type: "string", enum: ["file", "workspace", "open"] },
			path: {
				type: "string",
				description:
					"file: the note; workspace: the folder. Relative to a workspace root, or absolute.",
			},
			since: {
				type: "string",
				description: "The cursor returned by the previous call.",
			},
			name: {
				type: "string",
				description: 'Who is watching, shown on the badge (default "Agent").',
			},
			machine: {
				type: "string",
				description: "Where the agent runs, shown on the badge.",
			},
		},
		required: ["scope"],
		additionalProperties: false,
	},
	// Returns comment/edit text written by people: model-read, so flagged untrusted.
	annotations: { readOnlyHint: true, untrustedContentHint: true },
	async execute(input, ctx) {
		try {
			if (!ctx.appDataDir) throw new Error("The agent hook is unavailable.");
			const scope = await resolveScope(input, ctx);
			const name = str(input, "name", false) ?? "Agent";
			const now = new Date().toISOString();
			await upsertSubscriber(ctx.appDataDir, {
				id: pollerId(name, scope),
				scope,
				name,
				machine: str(input, "machine", false) ?? "MCP",
				host: os.hostname(),
				pid: process.pid,
				startedAt: now,
				heartbeatAt: now,
			});
			const { events, cursor } = await readScopeEvents(
				ctx.appDataDir,
				scope,
				str(input, "since", false),
			);
			const lines = events.map(({ event, path }) => ({ ...event, path }));
			return textResult(
				lines.length === 0
					? "No new events."
					: lines.map((line) => JSON.stringify(line)).join("\n"),
				{ events: lines, cursor },
			);
		} catch (error) {
			return errorResult(
				error instanceof Error ? error.message : String(error),
			);
		}
	},
};
