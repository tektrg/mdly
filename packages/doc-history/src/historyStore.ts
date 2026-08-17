import type { Compressor, DocHistoryFileSystem } from "./fs.js";
import { contentHash, textToBytes } from "./hash.js";
import { generateId } from "./ids.js";
import { isVersionableMarkdownPath } from "./markdownFilter.js";
import type { ObjectReadResult } from "./objectStore.js";
import { readObject, writeObject } from "./objectStore.js";
import { resolvePathIndex } from "./pathIndex.js";
import { joinPath } from "./paths.js";
import { forgetPath, recordRename, resolveOrAssignDocId } from "./rename.js";
import type { Revision, RevisionAuthor, RevisionCause } from "./revisionLog.js";
import { appendLogEntry, readRevisionHistory } from "./revisionLog.js";

export interface HistoryStoreOptions {
	fs: DocHistoryFileSystem;
	compressor: Compressor;
	/** The workspace root; history is stored under `<workspaceRoot>/.mdly/history`. */
	workspaceRoot: string;
}

export interface RecordRevisionInput {
	by: RevisionAuthor;
	cause: RevisionCause;
}

export type RecordRevisionResult =
	| { status: "recorded"; docId: string; revision: Revision }
	| { status: "skipped"; reason: "not-markdown" }
	| { status: "skipped"; reason: "duplicate"; docId: string };

export type ReadRevisionContentResult =
	| ObjectReadResult
	| { status: "not-found" };

export interface DocHistoryStore {
	/** `<workspaceRoot>/.mdly/history` — exposed for callers that need the raw path (e.g. hiding it from git-status scans). */
	readonly historyRoot: string;
	recordRevision(
		relativePath: string,
		content: string | Uint8Array,
		input: RecordRevisionInput,
	): Promise<RecordRevisionResult>;
	getRevisionHistory(relativePath: string): Promise<Revision[]>;
	readRevisionContent(
		relativePath: string,
		revisionId: string,
	): Promise<ReadRevisionContentResult>;
	resolveDocId(relativePath: string): Promise<{ id: string; isNew: boolean }>;
	renamePath(fromPath: string, toPath: string): Promise<{ id: string }>;
	/** See `rename.ts`'s `forgetPath` — breaks a path's binding so a later unrelated document is never fused onto it (R33). */
	forgetDocumentAtPath(relativePath: string): Promise<void>;
}

const HISTORY_DIR_SEGMENTS = [".mdly", "history"];

export function historyRootFor(workspaceRoot: string): string {
	return joinPath(workspaceRoot, ...HISTORY_DIR_SEGMENTS);
}

/** Serializes same-key async operations so two triggers racing on one document never branch its log (R27). */
function createKeyedLock() {
	const pending = new Map<string, Promise<unknown>>();
	return function withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
		const prior = pending.get(key) ?? Promise.resolve();
		const next = prior.then(run, run);
		pending.set(
			key,
			next.then(
				() => undefined,
				() => undefined,
			),
		);
		return next;
	};
}

export function createHistoryStore(
	options: HistoryStoreOptions,
): DocHistoryStore {
	const { fs, compressor } = options;
	const historyRoot = historyRootFor(options.workspaceRoot);
	const withPathLock = createKeyedLock();

	async function recordRevision(
		relativePath: string,
		content: string | Uint8Array,
		input: RecordRevisionInput,
	): Promise<RecordRevisionResult> {
		return withPathLock(relativePath, async () => {
			if (!isVersionableMarkdownPath(relativePath)) {
				return { status: "skipped", reason: "not-markdown" };
			}
			const bytes =
				typeof content === "string" ? textToBytes(content) : content;
			const hash = await contentHash(bytes);
			const { id: docId } = await resolveOrAssignDocId(
				fs,
				historyRoot,
				relativePath,
			);
			const history = await readRevisionHistory(fs, historyRoot, docId);
			const head = history.length > 0 ? history[history.length - 1] : null;
			if (head && head.hash === hash) {
				return { status: "skipped", reason: "duplicate", docId };
			}

			await writeObject({ fs, compressor }, historyRoot, bytes);
			const revision: Revision = {
				id: generateId(),
				hash,
				at: Date.now(),
				by: input.by,
				cause: input.cause,
				bytes: bytes.byteLength,
				prev: head?.id ?? null,
			};
			await appendLogEntry(fs, historyRoot, docId, {
				entryKind: "revision",
				...revision,
			});
			return { status: "recorded", docId, revision };
		});
	}

	async function getRevisionHistory(relativePath: string): Promise<Revision[]> {
		const docId = (await resolvePathIndex(fs, historyRoot)).get(relativePath);
		if (!docId) return [];
		return readRevisionHistory(fs, historyRoot, docId);
	}

	async function readRevisionContent(
		relativePath: string,
		revisionId: string,
	): Promise<ReadRevisionContentResult> {
		const revision = (await getRevisionHistory(relativePath)).find(
			(entry) => entry.id === revisionId,
		);
		if (!revision) return { status: "not-found" };
		return readObject({ fs, compressor }, historyRoot, revision.hash);
	}

	function resolveDocId(relativePath: string) {
		return withPathLock(relativePath, () =>
			resolveOrAssignDocId(fs, historyRoot, relativePath),
		);
	}

	function renamePath(fromPath: string, toPath: string) {
		return withPathLock(fromPath, () =>
			recordRename(fs, historyRoot, fromPath, toPath),
		);
	}

	function forgetDocumentAtPath(relativePath: string) {
		return withPathLock(relativePath, () =>
			forgetPath(fs, historyRoot, relativePath),
		);
	}

	return {
		historyRoot,
		recordRevision,
		getRevisionHistory,
		readRevisionContent,
		resolveDocId,
		renamePath,
		forgetDocumentAtPath,
	};
}
