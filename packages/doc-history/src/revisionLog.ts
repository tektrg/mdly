import type { DocHistoryFileSystem } from "./fs.js";
import {
	appendJsonlLine,
	findJsonlSiblingPaths,
	readMergedJsonlEntries,
} from "./jsonlLog.js";
import { joinPath } from "./paths.js";

export type RevisionAuthorKind = "human" | "agent" | "external";

export interface RevisionAuthor {
	kind: RevisionAuthorKind;
	id: string;
	label?: string;
}

export type RevisionCause =
	| "external-write"
	| "idle-session"
	| "manual"
	| "import"
	| "restore";

/** The public, 7-field revision shape (R3). */
export interface Revision {
	id: string;
	hash: string;
	at: number;
	by: RevisionAuthor;
	cause: RevisionCause;
	bytes: number;
	prev: string | null;
}

/**
 * Path↔id lifecycle events (assign / rename / release) ride in the same
 * per-document JSONL log as revisions, tagged by `entryKind`, so the
 * path↔id index remains rebuildable from the per-document logs alone (R10).
 */
export interface LifecycleLogEntry {
	entryKind: "assign" | "rename" | "release";
	id: string;
	at: number;
	path: string;
	fromPath?: string;
}

export type PersistedRevisionEntry = Revision & { entryKind: "revision" };
export type LogEntry = PersistedRevisionEntry | LifecycleLogEntry;

/** Strips the on-disk-only `entryKind` discriminator down to the public 7-field shape. */
function toPublicRevision(entry: PersistedRevisionEntry): Revision {
	return {
		id: entry.id,
		hash: entry.hash,
		at: entry.at,
		by: entry.by,
		cause: entry.cause,
		bytes: entry.bytes,
		prev: entry.prev,
	};
}

const LOG_DIR = "log";

export function logDirPath(historyRoot: string): string {
	return joinPath(historyRoot, LOG_DIR);
}

export function logFilePath(historyRoot: string, docId: string): string {
	return joinPath(logDirPath(historyRoot), `${docId}.jsonl`);
}

/** Appends one JSON line to a document's canonical log file (never a fork). */
export async function appendLogEntry(
	fs: DocHistoryFileSystem,
	historyRoot: string,
	docId: string,
	entry: LogEntry,
): Promise<void> {
	await appendJsonlLine(fs, logFilePath(historyRoot, docId), entry);
}

/**
 * Reads and merges every sibling of a document's log, deduped by `id`. Order
 * is unspecified here — callers that need edit order use
 * `readRevisionHistory`, which re-linearizes via `prev` (R4, R5).
 */
export async function readMergedLogEntries(
	fs: DocHistoryFileSystem,
	historyRoot: string,
	docId: string,
): Promise<LogEntry[]> {
	const paths = await findJsonlSiblingPaths(fs, logDirPath(historyRoot), docId);
	return readMergedJsonlEntries<LogEntry>(fs, paths);
}

/**
 * Reconstructs a document's revision history in true edit order by walking
 * the `prev` chain from the newest revision — never by sorting on `at`, so
 * clock skew across a forked/merged log never reorders history (R4, R26).
 *
 * If the merged entries contain more than one chain (a true concurrent
 * branch across independent writers — not exercised by any locked-down
 * test, and an accepted risk per the plan's own "sync-fork tolerance is
 * unproven in the field" note), the chain reachable from the
 * lexicographically-greatest id is treated as canonical and any unreached
 * revisions are appended afterwards sorted by id, so nothing is ever
 * silently dropped (R5) even in that untested case.
 */
export async function readRevisionHistory(
	fs: DocHistoryFileSystem,
	historyRoot: string,
	docId: string,
): Promise<Revision[]> {
	const merged = await readMergedLogEntries(fs, historyRoot, docId);
	const revisions = merged.filter(
		(entry): entry is PersistedRevisionEntry => entry.entryKind === "revision",
	);
	if (revisions.length === 0) return [];

	const byId = new Map(revisions.map((revision) => [revision.id, revision]));
	const referenced = new Set(
		revisions
			.map((revision) => revision.prev)
			.filter((id): id is string => id !== null),
	);
	const heads = revisions
		.filter((revision) => !referenced.has(revision.id))
		.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

	const chain: PersistedRevisionEntry[] = [];
	const visited = new Set<string>();
	let cursor: PersistedRevisionEntry | undefined = heads[0];
	while (cursor && !visited.has(cursor.id)) {
		visited.add(cursor.id);
		chain.unshift(cursor);
		cursor = cursor.prev ? byId.get(cursor.prev) : undefined;
	}

	const leftover = revisions
		.filter((revision) => !visited.has(revision.id))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	return [...chain, ...leftover].map(toPublicRevision);
}

export async function readLifecycleEntries(
	fs: DocHistoryFileSystem,
	historyRoot: string,
	docId: string,
): Promise<LifecycleLogEntry[]> {
	const merged = await readMergedLogEntries(fs, historyRoot, docId);
	return merged.filter(
		(entry): entry is LifecycleLogEntry => entry.entryKind !== "revision",
	);
}

/** Lists every document id that currently has a log file (for reindexing). */
export async function listDocIds(
	fs: DocHistoryFileSystem,
	historyRoot: string,
): Promise<string[]> {
	const names = await fs.listDir(logDirPath(historyRoot));
	const ids = new Set<string>();
	for (const name of names) {
		const match = name.match(/^(.+?)( \d+)?\.jsonl$/);
		if (match) ids.add(match[1]);
	}
	return [...ids];
}
