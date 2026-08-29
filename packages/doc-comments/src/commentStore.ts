import type { DocHistoryFileSystem } from "@mdly/doc-history";
import { generateId } from "@mdly/doc-history";
import { resolveAnchor } from "./anchor.js";
import type { FlattenDocument, ReadRevisionContent } from "./anchor.js";
import { appendCommentEvent, readCommentEvents } from "./commentLog.js";
import type {
	AnyCommentEvent,
	CommentThread,
	OpenThreadOptions,
	ReopenOptions,
	ReplyOptions,
	ResolveOptions,
	ThreadOpenedEvent,
} from "./types.js";

export type { ReadRevisionContent, FlattenDocument };

export interface CommentStoreOptions {
	/** Function to read revision content (for re-anchoring fallback). */
	readRevisionContent: ReadRevisionContent;
	/** Function to flatten document text to rendered-text space. */
	flattenDocument: FlattenDocument;
}

/**
 * Per-docId keyed lock so concurrent read-then-append operations (reply,
 * resolve, reopen, open) never race and fork the prev chain (R5). Mirrors
 * doc-history's historyStore.ts createKeyedLock: each call waits for the
 * prior holder to fully finish before running, and only releases once its
 * own critical section has completed.
 */
const pendingByDocId = new Map<string, Promise<unknown>>();

function withDocLock<T>(docId: string, run: () => Promise<T>): Promise<T> {
	const prior = pendingByDocId.get(docId) ?? Promise.resolve();
	const next = prior.then(run, run);
	pendingByDocId.set(
		docId,
		next.then(
			() => undefined,
			() => undefined,
		),
	);
	return next;
}

/**
 * The event never referenced by another event's `prev` with the greatest id
 * is the thread head. Mirrors doc-history's revisionLog.ts head selection so
 * a fork (two events appended with the same prev) resolves deterministically
 * instead of hanging or picking arbitrarily.
 */
function findHead(threadEvents: AnyCommentEvent[]): AnyCommentEvent | null {
	if (threadEvents.length === 0) return null;
	const referenced = new Set(
		threadEvents
			.map((e) => e.prev)
			.filter((prev): prev is string => prev !== null),
	);
	const unreferenced = threadEvents.filter((e) => !referenced.has(e.id));
	const pool = unreferenced.length > 0 ? unreferenced : threadEvents;
	return pool.reduce((max, e) => (e.id > max.id ? e : max), pool[0]);
}

/**
 * Orders a thread's events for display: breadth-first from the opener
 * following `prev` pointers (siblings from a fork sort by id and both
 * survive), then any unreachable/dangling events appended sorted by id so
 * nothing is ever dropped (R6/QA6). Cycle- and dangling-prev-safe via a
 * visited set plus a bounded watchdog.
 */
function orderThreadEvents(threadEvents: AnyCommentEvent[]): AnyCommentEvent[] {
	const opener = threadEvents.find((e) => e.kind === "thread-opened");
	if (!opener) return [];

	const childrenByPrev = new Map<string, AnyCommentEvent[]>();
	for (const event of threadEvents) {
		if (event.prev === null) continue;
		const list = childrenByPrev.get(event.prev) ?? [];
		list.push(event);
		childrenByPrev.set(event.prev, list);
	}
	for (const list of childrenByPrev.values()) {
		list.sort((a, b) => a.id.localeCompare(b.id));
	}

	const ordered: AnyCommentEvent[] = [];
	const visited = new Set<string>();
	const queue: AnyCommentEvent[] = [opener];
	const maxSteps = threadEvents.length * 4 + 16;
	let steps = 0;

	while (queue.length > 0 && steps < maxSteps) {
		steps++;
		const node = queue.shift();
		if (!node || visited.has(node.id)) continue;
		visited.add(node.id);
		ordered.push(node);
		queue.push(...(childrenByPrev.get(node.id) ?? []));
	}

	const leftover = threadEvents
		.filter((e) => !visited.has(e.id))
		.sort((a, b) => a.id.localeCompare(b.id));
	return [...ordered, ...leftover];
}

async function buildThread(
	docId: string,
	threadEvents: AnyCommentEvent[],
	currentFlattenedText: string,
	options: CommentStoreOptions,
): Promise<CommentThread | null> {
	const opener = threadEvents.find(
		(e): e is ThreadOpenedEvent => e.kind === "thread-opened",
	);
	if (!opener) return null;

	const head = findHead(threadEvents) ?? opener;
	const anchorResolution = await resolveAnchor(
		opener.anchor,
		currentFlattenedText,
		options.readRevisionContent,
		options.flattenDocument,
	);

	return {
		id: opener.threadId,
		docId,
		opener,
		events: orderThreadEvents(threadEvents),
		state: head.kind === "resolved" ? "resolved" : "open",
		anchorResolution,
	};
}

/** Lists all comment threads for a document, newest-opened-last. */
export async function listThreads(
	fs: DocHistoryFileSystem,
	workspaceRoot: string,
	docId: string,
	currentFlattenedText: string,
	options: CommentStoreOptions,
): Promise<CommentThread[]> {
	const events = await readCommentEvents(fs, workspaceRoot, docId);
	const byThread = new Map<string, AnyCommentEvent[]>();
	for (const event of events) {
		const list = byThread.get(event.threadId) ?? [];
		list.push(event);
		byThread.set(event.threadId, list);
	}

	const threads: CommentThread[] = [];
	for (const threadEvents of byThread.values()) {
		const thread = await buildThread(
			docId,
			threadEvents,
			currentFlattenedText,
			options,
		);
		if (thread) threads.push(thread);
	}

	return threads.sort((a, b) => a.opener.id.localeCompare(b.opener.id));
}

async function currentHead(
	fs: DocHistoryFileSystem,
	workspaceRoot: string,
	docId: string,
	threadId: string,
): Promise<AnyCommentEvent | null> {
	const events = await readCommentEvents(fs, workspaceRoot, docId);
	const threadEvents = events.filter((e) => e.threadId === threadId);
	return findHead(threadEvents);
}

/** Opens a new thread on a document. Rejects on an empty selection/quote (R13). */
export async function openThread(
	fs: DocHistoryFileSystem,
	workspaceRoot: string,
	options: OpenThreadOptions,
): Promise<void> {
	if (options.anchor.from >= options.anchor.to || options.anchor.quote.length === 0) {
		throw new Error("Cannot create a comment thread on an empty selection");
	}

	await withDocLock(options.docId, async () => {
		const id = generateId();
		const event: ThreadOpenedEvent = {
			id,
			threadId: id,
			kind: "thread-opened",
			prev: null,
			by: options.author,
			anchor: options.anchor,
			text: options.text,
		};
		await appendCommentEvent(fs, workspaceRoot, options.docId, event);
	});
}

/** Replies to a thread. A reply on a resolved thread reopens it (D10). */
export async function reply(
	fs: DocHistoryFileSystem,
	workspaceRoot: string,
	options: ReplyOptions,
): Promise<void> {
	await withDocLock(options.docId, async () => {
		const head = await currentHead(
			fs,
			workspaceRoot,
			options.docId,
			options.threadId,
		);
		const event: AnyCommentEvent = {
			id: generateId(),
			threadId: options.threadId,
			kind: "replied",
			prev: head?.id ?? null,
			by: options.author,
			text: options.text,
		};
		await appendCommentEvent(fs, workspaceRoot, options.docId, event);
	});
}

/** Resolves a thread. */
export async function resolve(
	fs: DocHistoryFileSystem,
	workspaceRoot: string,
	options: ResolveOptions,
): Promise<void> {
	await withDocLock(options.docId, async () => {
		const head = await currentHead(
			fs,
			workspaceRoot,
			options.docId,
			options.threadId,
		);
		const event: AnyCommentEvent = {
			id: generateId(),
			threadId: options.threadId,
			kind: "resolved",
			prev: head?.id ?? null,
			by: options.author,
		};
		await appendCommentEvent(fs, workspaceRoot, options.docId, event);
	});
}

/** Reopens a resolved thread. */
export async function reopen(
	fs: DocHistoryFileSystem,
	workspaceRoot: string,
	options: ReopenOptions,
): Promise<void> {
	await withDocLock(options.docId, async () => {
		const head = await currentHead(
			fs,
			workspaceRoot,
			options.docId,
			options.threadId,
		);
		const event: AnyCommentEvent = {
			id: generateId(),
			threadId: options.threadId,
			kind: "reopened",
			prev: head?.id ?? null,
			by: options.author,
		};
		await appendCommentEvent(fs, workspaceRoot, options.docId, event);
	});
}
