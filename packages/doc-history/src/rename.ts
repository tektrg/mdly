import type { DocHistoryFileSystem } from "./fs.js";
import { generateId } from "./ids.js";
import { appendPathIndexEntry, resolvePathIndex } from "./pathIndex.js";
import { appendLogEntry } from "./revisionLog.js";

export interface ResolveDocIdResult {
	id: string;
	/** True the very first time this path was ever seen (R8, R24). */
	isNew: boolean;
}

/**
 * The first time a workspace-relative path is seen, mints a permanent
 * document id for it (R8) and records the assignment, append-only, both in
 * the top-level path↔id index and in the new document's own log (so the
 * index stays rebuildable from logs alone, R10). Later calls for the same
 * path return the same id unchanged.
 */
export async function resolveOrAssignDocId(
	fs: DocHistoryFileSystem,
	historyRoot: string,
	path: string,
): Promise<ResolveDocIdResult> {
	const existing = await resolvePathIndex(fs, historyRoot);
	const knownId = existing.get(path);
	if (knownId) return { id: knownId, isNew: false };

	const id = generateId();
	const at = Date.now();
	await appendPathIndexEntry(fs, historyRoot, {
		id: generateId(),
		at,
		event: "assign",
		docId: id,
		path,
	});
	await appendLogEntry(fs, historyRoot, id, {
		entryKind: "assign",
		id: generateId(),
		at,
		path,
	});
	return { id, isNew: true };
}

/**
 * Renames a document, matching the real `desktop:rename-file` mechanics:
 * the document keeps its id and its one, unbroken log — a rename never
 * starts a second log or orphans earlier revisions (R11). If `fromPath` was
 * never registered (a write hook reached this without an earlier
 * `recordRename`/`resolveOrAssignDocId` call — R42), it is treated as
 * first-seen at `fromPath` and assigned a fresh id before the rename, so the
 * operation still degrades safely rather than throwing.
 */
export async function recordRename(
	fs: DocHistoryFileSystem,
	historyRoot: string,
	fromPath: string,
	toPath: string,
): Promise<{ id: string }> {
	const existing = await resolvePathIndex(fs, historyRoot);
	const id =
		existing.get(fromPath) ??
		(await resolveOrAssignDocId(fs, historyRoot, fromPath)).id;

	const at = Date.now();
	await appendPathIndexEntry(fs, historyRoot, {
		id: generateId(),
		at,
		event: "rename",
		docId: id,
		path: toPath,
		fromPath,
	});
	await appendLogEntry(fs, historyRoot, id, {
		entryKind: "rename",
		id: generateId(),
		at,
		path: toPath,
		fromPath,
	});
	return { id };
}

/**
 * Breaks a path's binding to its document without assigning a replacement,
 * so that unrelated new content later written to the same path mints a
 * fresh id instead of silently continuing the old document's log (R33).
 *
 * Wired to the real `desktop:delete-file` IPC handler via
 * `recordDeleteHistory` in `apps/desktop/electron/docHistoryWiring.ts`,
 * called right after the real delete succeeds.
 */
export async function forgetPath(
	fs: DocHistoryFileSystem,
	historyRoot: string,
	path: string,
): Promise<void> {
	const existing = await resolvePathIndex(fs, historyRoot);
	const docId = existing.get(path);
	if (!docId) return;
	await appendPathIndexEntry(fs, historyRoot, {
		id: generateId(),
		at: Date.now(),
		event: "release",
		docId,
		path,
	});
}
