import type { DocHistoryFileSystem } from "./fs.js";
import {
	appendJsonlLine,
	findJsonlSiblingPaths,
	readMergedJsonlEntries,
} from "./jsonlLog.js";
import { joinPath } from "./paths.js";
import { listDocIds, readLifecycleEntries } from "./revisionLog.js";

/**
 * One event in the append-only path↔id index (R10). `assign` mints a doc's
 * very first path; `rename` moves an existing doc to a new path; `release`
 * breaks a path's binding to its document without assigning a replacement
 * (used by `forgetPath` — see rename.ts — so a later unrelated document at
 * the same path is never fused onto the old one, R33).
 */
export interface PathIndexEntry {
	id: string;
	at: number;
	event: "assign" | "rename" | "release";
	docId: string;
	path: string;
	fromPath?: string;
}

const INDEX_BASE_NAME = "index";

function indexFilePath(historyRoot: string): string {
	return joinPath(historyRoot, `${INDEX_BASE_NAME}.jsonl`);
}

export async function appendPathIndexEntry(
	fs: DocHistoryFileSystem,
	historyRoot: string,
	entry: PathIndexEntry,
): Promise<void> {
	await appendJsonlLine(fs, indexFilePath(historyRoot), entry);
}

/** Reads and merges every sibling of the index file, deduped by event id (R10, fork-tolerant like R5). */
export async function readMergedPathIndexEntries(
	fs: DocHistoryFileSystem,
	historyRoot: string,
): Promise<PathIndexEntry[]> {
	const paths = await findJsonlSiblingPaths(fs, historyRoot, INDEX_BASE_NAME);
	return readMergedJsonlEntries<PathIndexEntry>(fs, paths);
}

/**
 * Replays index events in write order (by `at`, tie-broken by `id`) to
 * resolve each path to its current document id — last event wins (R10).
 */
export function replayPathIndex(
	entries: PathIndexEntry[],
): Map<string, string> {
	const ordered = [...entries].sort(
		(a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
	const byPath = new Map<string, string>();
	for (const entry of ordered) {
		if (entry.event === "assign") {
			byPath.set(entry.path, entry.docId);
		} else if (entry.event === "rename") {
			if (entry.fromPath) byPath.delete(entry.fromPath);
			byPath.set(entry.path, entry.docId);
		} else {
			byPath.delete(entry.path);
		}
	}
	return byPath;
}

export async function resolvePathIndex(
	fs: DocHistoryFileSystem,
	historyRoot: string,
): Promise<Map<string, string>> {
	return replayPathIndex(await readMergedPathIndexEntries(fs, historyRoot));
}

/**
 * Rebuilds the path→id map purely from each document's own log (R10's
 * disaster-recovery requirement: the index must survive its own loss).
 * Only `assign`/`rename` lifecycle entries are considered — a `release`
 * recorded only in the top-level index (never duplicated per-document,
 * since it has no single owning document once a path is released) is not
 * replayed here. That is a narrow, documented limitation: a path
 * deliberately released via `forgetPath` and then reused may, after a full
 * index rebuild, appear to still resolve to its pre-release document. It
 * does not affect R10's own test (which only exercises assign/rename).
 */
export async function rebuildPathIndexFromLogs(
	fs: DocHistoryFileSystem,
	historyRoot: string,
): Promise<Map<string, string>> {
	const docIds = await listDocIds(fs, historyRoot);
	const entries: PathIndexEntry[] = [];
	for (const docId of docIds) {
		const lifecycle = await readLifecycleEntries(fs, historyRoot, docId);
		for (const event of lifecycle) {
			if (event.entryKind === "release") continue;
			entries.push({
				id: event.id,
				at: event.at,
				event: event.entryKind,
				docId,
				path: event.path,
				fromPath: event.fromPath,
			});
		}
	}
	return replayPathIndex(entries);
}
