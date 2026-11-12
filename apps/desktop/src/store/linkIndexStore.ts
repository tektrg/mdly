import { store } from "@simplestack/store";
import {
	batchLinkIndex,
	createLinkIndex,
	type LinkIndex,
	pathKey,
	removeLinkSource,
	setLinkSource,
	sourceMtime,
} from "../lib/linkIndex";
import { workspacePathStore } from "./state";

/**
 * Renderer-side owner of the workspace link index (`lib/linkIndex.ts`).
 *
 * Lazy: nothing is read until a consumer (the Backlinks panel, later the graph
 * view) calls `syncLinkIndex`. Incremental: like `tagScanStore`, a sync diffs
 * the listing's mtimes against what was indexed and reads only new/changed
 * files, so a refocus or a watcher tick that changed nothing reads zero files.
 * Deleted and renamed files fall out of the listing diff (old path dropped,
 * new path read). The workspace scan itself is untouched.
 *
 * The index object is mutable and lives outside the store; the store carries
 * a `version` that bumps on every change so React consumers re-derive.
 */

export type LinkIndexStatus = "idle" | "indexing" | "ready" | "failed";

export type LinkIndexState = {
	scope: string | null;
	status: LinkIndexStatus;
	version: number;
};

export type LinkIndexFile = { path: string; modifiedAt: number };

export const linkIndexStore = store<LinkIndexState>({
	scope: null,
	status: "idle",
	version: 0,
});

let index: LinkIndex = createLinkIndex();
let syncRequest = 0;
const READ_CONCURRENCY = 8;

export function currentLinkIndex(): LinkIndex {
	return index;
}

function bump(status?: LinkIndexStatus) {
	linkIndexStore.set((state) => ({
		...state,
		status: status ?? state.status,
		version: state.version + 1,
	}));
}

/** Paths the next sync must read: new to the index, or mtime moved. */
export function linkIndexPathsToRead(
	current: LinkIndex,
	files: readonly LinkIndexFile[],
): string[] {
	return files
		.filter((file) => sourceMtime(current, file.path) !== file.modifiedAt)
		.map((file) => file.path);
}

/**
 * Brings the index in line with a workspace listing. A sync superseded by a
 * newer one (or a workspace switch) stops writing as soon as it notices.
 */
export async function syncLinkIndex(
	scope: string,
	files: readonly LinkIndexFile[],
	readFile: (path: string) => Promise<string>,
): Promise<void> {
	const request = ++syncRequest;
	if (linkIndexStore.get().scope !== scope) {
		index = createLinkIndex(scope);
		linkIndexStore.set({ scope, status: "idle", version: 0 });
	}
	// Name-driven wiki re-resolution runs once per affected source when the
	// last overlapping sync ends, not once per added namesake.
	const target = index;
	const endBatch = batchLinkIndex(target);
	let status: LinkIndexStatus | null;
	try {
		status = await applySync(request, target, files, readFile);
	} finally {
		endBatch();
	}
	if (status && request === syncRequest) bump(status);
}

/** The listing diff + reads; returns the status to publish, or null. */
async function applySync(
	request: number,
	index: LinkIndex,
	files: readonly LinkIndexFile[],
	readFile: (path: string) => Promise<string>,
): Promise<LinkIndexStatus | null> {
	const live = new Set(files.map((file) => pathKey(file.path)));
	let removed = false;
	for (const [key, entry] of [...index.sources]) {
		if (!live.has(key)) {
			removeLinkSource(index, entry.path);
			removed = true;
		}
	}
	const toRead = linkIndexPathsToRead(index, files);
	if (toRead.length === 0)
		return removed || linkIndexStore.get().status !== "ready" ? "ready" : null;
	if (linkIndexStore.get().status !== "ready") bump("indexing");
	const mtimeByPath = new Map(files.map((f) => [f.path, f.modifiedAt]));
	let cursor = 0;
	let failures = 0;
	const worker = async () => {
		while (cursor < toRead.length) {
			const path = toRead[cursor++] as string;
			try {
				const content = await readFile(path);
				if (request !== syncRequest) return;
				setLinkSource(index, path, content, mtimeByPath.get(path) ?? 0);
			} catch {
				// A file that vanished or is unreadable mid-sync just has no links.
				failures++;
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(READ_CONCURRENCY, toRead.length) }, worker),
	);
	if (request !== syncRequest) return null;
	return failures === toRead.length ? "failed" : "ready";
}

/**
 * Re-indexes one document from text just saved, so the panel reflects an
 * edit immediately. mtime -1 forces one re-read on the next sync — the real
 * mtime is only known after the write, and a forged one could mask an
 * external edit (same trade as `upsertTagsForPath`).
 */
export function noteSavedLinkSource(path: string, content: string) {
	if (linkIndexStore.get().scope === null) return;
	setLinkSource(index, path, content, -1);
	bump();
}

/** Test seam / workspace close. */
export function resetLinkIndex() {
	syncRequest++;
	index = createLinkIndex();
	linkIndexStore.set({ scope: null, status: "idle", version: 0 });
}

// Closing or switching the workspace drops the old index, so a stale graph
// never outlives its workspace (the next sync rebuilds for the new scope).
workspacePathStore.subscribe((next) => {
	if (linkIndexStore.get().scope !== (next ?? null)) resetLinkIndex();
});
