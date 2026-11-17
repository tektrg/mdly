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
	/** Which visible match of `find` (1-based, document order) when it occurs more than once. */
	occurrence?: number;
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

/** Past this size an event file is compacted (settled history rotated out). */
export const COMPACT_AT_BYTES = 256 * 1024;

export interface AppendOptions {
	compactAtBytes?: number;
}

/** The previous generation of a doc's event file (one kept, then overwritten). */
export function rotatedEventsPath(
	workspaceRoot: string,
	relativePath: string,
): string {
	return eventsPath(workspaceRoot, relativePath).replace(
		/\.events\.jsonl$/,
		".events.1.jsonl",
	);
}

// In-process writers to one file are serialized (the app is the only writer).
const fileLocks = new Map<string, Promise<unknown>>();
function withFileLock<T>(file: string, task: () => Promise<T>): Promise<T> {
	const previous = fileLocks.get(file) ?? Promise.resolve();
	const next = previous.then(task, task);
	const settled = next.catch(() => undefined);
	fileLocks.set(file, settled);
	void settled.then(() => {
		if (fileLocks.get(file) === settled) fileLocks.delete(file);
	});
	return next;
}

/**
 * Appends one event as a single line (one `write` with O_APPEND, so
 * concurrent appenders never interleave a line). Once the file passes
 * `compactAtBytes` it is compacted: the current file becomes the single
 * rotated generation and a fresh file starts with only the still-pending
 * proposals, marked `carried` so tailers never re-emit them.
 */
export async function appendHookEvent(
	workspaceRoot: string,
	event: HookEvent,
	options: AppendOptions = {},
): Promise<void> {
	if (!HOOK_EVENT_TYPES.includes(event.type)) {
		throw new TypeError(`Unknown hook event type: ${String(event.type)}`);
	}
	const file = eventsPath(workspaceRoot, event.doc);
	await withFileLock(file, async () => {
		await fs.mkdir(hookDir(workspaceRoot), { recursive: true });
		await fs.appendFile(file, `${JSON.stringify(event)}\n`);
		const size = (await fs.stat(file)).size;
		if (size > (options.compactAtBytes ?? COMPACT_AT_BYTES)) {
			await compactLocked(workspaceRoot, event.doc);
		}
	});
}

async function compactLocked(
	workspaceRoot: string,
	relativePath: string,
): Promise<void> {
	const file = eventsPath(workspaceRoot, relativePath);
	const events = parseHookLines(await fs.readFile(file, "utf8"));
	const pending = new Set(pendingProposals(events).map((p) => p.proposalId));
	const carried = events
		.filter(
			(e) =>
				e.type === "edit.proposed" &&
				typeof e.proposalId === "string" &&
				pending.has(e.proposalId),
		)
		.map((e) => `${JSON.stringify({ ...e, carried: true })}\n`)
		.join("");
	const tmp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(tmp, carried);
	// Rotate first so a tailer can drain the old generation by inode.
	await fs.rename(file, rotatedEventsPath(workspaceRoot, relativePath));
	await fs.rename(tmp, file);
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
	const state = new ProposalState();
	for (const e of events) state.apply(e);
	return state.pending();
}

const SETTLING_TYPES: ReadonlySet<HookEventType> = new Set([
	"suggestion.accepted",
	"suggestion.rejected",
]);

/** Folds events into the pending-proposal set; order-independent for settle-before-propose. */
class ProposalState {
	private proposals = new Map<string, EditProposal>();
	private settled = new Set<string>();
	apply(e: HookEvent): void {
		if (SETTLING_TYPES.has(e.type) && typeof e.proposalId === "string") {
			this.settled.add(e.proposalId);
			this.proposals.delete(e.proposalId);
			return;
		}
		if (e.type !== "edit.proposed") return;
		const proposalId = e.proposalId;
		if (typeof proposalId !== "string" || this.settled.has(proposalId)) return;
		if (this.proposals.has(proposalId)) return;
		this.proposals.set(proposalId, toProposal(proposalId, e));
	}
	pending(): EditProposal[] {
		return [...this.proposals.values()];
	}
}

function toProposal(proposalId: string, e: HookEvent): EditProposal {
	return {
		proposalId,
		find: String(e.find ?? ""),
		replace: String(e.replace ?? ""),
		occurrence:
			typeof e.occurrence === "number" && e.occurrence >= 1
				? e.occurrence
				: undefined,
		note: typeof e.note === "string" ? e.note : undefined,
		author: typeof e.author === "string" ? e.author : undefined,
	};
}

export interface ProposalReader {
	read(workspaceRoot: string, relativePath: string): Promise<EditProposal[]>;
	/** Bytes read by the last `read` (0 when the file had not changed). */
	readonly lastReadBytes: number;
}

/**
 * Pending proposals per doc, read incrementally: a `stat` per call, and only
 * the bytes appended since last time. A compaction (new inode) or truncation
 * triggers one full re-read of the (now small) file.
 */
export function createProposalReader(): ProposalReader {
	const cache = new Map<
		string,
		{ ino: number; offset: number; state: ProposalState }
	>();
	let lastReadBytes = 0;
	return {
		get lastReadBytes() {
			return lastReadBytes;
		},
		async read(workspaceRoot, relativePath) {
			lastReadBytes = 0;
			const file = eventsPath(workspaceRoot, relativePath);
			let stat: { ino: number; size: number };
			try {
				stat = await fs.stat(file);
			} catch {
				cache.delete(file);
				return [];
			}
			let entry = cache.get(file);
			if (!entry || entry.ino !== stat.ino || stat.size < entry.offset) {
				entry = { ino: stat.ino, offset: 0, state: new ProposalState() };
				cache.set(file, entry);
			}
			if (stat.size > entry.offset) {
				const { text, consumed } = await readCompleteLines(
					file,
					entry.offset,
					stat.size,
				);
				lastReadBytes = consumed;
				entry.offset += consumed;
				for (const e of parseHookLines(text)) entry.state.apply(e);
			}
			return entry.state.pending();
		},
	};
}

/** Reads `[from, to)` and returns only whole lines (a torn tail waits). */
export async function readCompleteLines(
	file: string,
	from: number,
	to: number,
): Promise<{ text: string; consumed: number }> {
	const handle = await fs.open(file, "r");
	try {
		const buffer = Buffer.alloc(Math.max(0, to - from));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
		const slice = buffer.subarray(0, bytesRead);
		const lastNewline = slice.lastIndexOf(0x0a);
		if (lastNewline < 0) return { text: "", consumed: 0 };
		return {
			text: slice.subarray(0, lastNewline + 1).toString("utf8"),
			consumed: lastNewline + 1,
		};
	} finally {
		await handle.close();
	}
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
