/**
 * The agent hook's durable event stream: one append-only JSONL file per
 * document under `<workspace>/.mdly/agent-hook/`. The app appends, `mdly
 * watch` tails. Because it is a file (not an in-memory bus or a socket):
 * - events and subscriptions survive an app restart,
 * - a watcher works with the app closed, and over plain `ssh` (stdout only),
 * - nothing is opened to the network.
 * Keyed by workspace-relative path: a rename starts a fresh stream (known limit).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type HookOrigin = "user" | "agent" | "app";

export type HookEventType =
	| "comment.added"
	| "comment.replied"
	| "doc.edited"
	| "edit.proposed"
	| "suggestion.accepted"
	| "suggestion.rejected"
	| "tool.requested";

export const HOOK_EVENT_TYPES: readonly HookEventType[] = [
	"comment.added",
	"comment.replied",
	"doc.edited",
	"edit.proposed",
	"suggestion.accepted",
	"suggestion.rejected",
	"tool.requested",
];

export interface HookEvent {
	v: 1;
	id: string;
	type: HookEventType;
	at: string;
	/** Workspace-relative path of the document. */
	doc: string;
	origin: HookOrigin;
	[key: string]: unknown;
}

export interface EditProposal {
	proposalId: string;
	/** Exact visible text to replace (within one paragraph). */
	find: string;
	replace: string;
	note?: string;
	author?: string;
}

export function hookDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, ".mdly", "agent-hook");
}

/** Filename-safe, collision-free key for a relative path. */
export function docKey(relativePath: string): string {
	return encodeURIComponent(relativePath.split(path.sep).join("/"));
}

export function eventsPath(
	workspaceRoot: string,
	relativePath: string,
): string {
	return path.join(
		hookDir(workspaceRoot),
		`${docKey(relativePath)}.events.jsonl`,
	);
}

/** The document text the agent last saw; `doc.edited` diffs against it. */
export function seenPath(workspaceRoot: string, relativePath: string): string {
	return path.join(hookDir(workspaceRoot), `${docKey(relativePath)}.seen.md`);
}

export function newHookEvent(
	type: HookEventType,
	doc: string,
	origin: HookOrigin,
	payload: Record<string, unknown> = {},
	now: Date = new Date(),
): HookEvent {
	return {
		...payload,
		v: 1,
		id: randomUUID(),
		type,
		at: now.toISOString(),
		doc,
		origin,
	};
}

/** Appends one event as a single line (one `write` with O_APPEND, so concurrent appenders never interleave a line). */
export async function appendHookEvent(
	workspaceRoot: string,
	event: HookEvent,
): Promise<void> {
	if (!HOOK_EVENT_TYPES.includes(event.type)) {
		throw new TypeError(`Unknown hook event type: ${String(event.type)}`);
	}
	await fs.mkdir(hookDir(workspaceRoot), { recursive: true });
	await fs.appendFile(
		eventsPath(workspaceRoot, event.doc),
		`${JSON.stringify(event)}\n`,
	);
}

/** Parses complete lines; a torn or malformed line is skipped, never thrown. */
export function parseHookLines(text: string): HookEvent[] {
	const events: HookEvent[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as HookEvent;
			if (parsed && HOOK_EVENT_TYPES.includes(parsed.type)) events.push(parsed);
		} catch {
			// torn tail or garbage — ignore
		}
	}
	return events;
}

export async function readHookEvents(
	workspaceRoot: string,
	relativePath: string,
): Promise<HookEvent[]> {
	try {
		return parseHookLines(
			await fs.readFile(eventsPath(workspaceRoot, relativePath), "utf8"),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

/** Proposals not yet accepted or rejected — what the editor should show as suggestions. */
export function pendingProposals(events: HookEvent[]): EditProposal[] {
	const settled = new Set<string>();
	for (const e of events) {
		if (
			(e.type === "suggestion.accepted" || e.type === "suggestion.rejected") &&
			typeof e.proposalId === "string"
		) {
			settled.add(e.proposalId);
		}
	}
	const pending: EditProposal[] = [];
	for (const e of events) {
		if (e.type !== "edit.proposed") continue;
		const proposalId = e.proposalId;
		if (typeof proposalId !== "string" || settled.has(proposalId)) continue;
		pending.push({
			proposalId,
			find: String(e.find ?? ""),
			replace: String(e.replace ?? ""),
			note: typeof e.note === "string" ? e.note : undefined,
			author: typeof e.author === "string" ? e.author : undefined,
		});
	}
	return pending;
}

export async function readSeen(
	workspaceRoot: string,
	relativePath: string,
): Promise<string | null> {
	try {
		return await fs.readFile(seenPath(workspaceRoot, relativePath), "utf8");
	} catch {
		return null;
	}
}

export async function writeSeen(
	workspaceRoot: string,
	relativePath: string,
	text: string,
): Promise<void> {
	await fs.mkdir(hookDir(workspaceRoot), { recursive: true });
	await fs.writeFile(seenPath(workspaceRoot, relativePath), text);
}
