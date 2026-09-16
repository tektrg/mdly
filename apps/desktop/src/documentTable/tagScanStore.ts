import { store } from "@simplestack/store";

/**
 * A9: the lazy front-matter tag scan, as four states instead of a silent catch.
 *
 * Replaces the `.catch(() => {})` in `components/Sidebar.tsx`, where a failed
 * scan was indistinguishable from "this workspace has no tags" — which would
 * render the entire workspace as one collapsed Untagged bucket.
 *
 * The workspace scope is carried INSIDE the value, never alongside it. There is
 * therefore no ordering to get right between "the workspace changed" and "the
 * tag map changed": a map for another workspace is not stale data, it is
 * unrepresentable as current (defect 12).
 */

export type TagsByPath = Record<string, string[]>;

/** A workspace path, or null when no workspace is open. */
export type TagScanScope = string | null;

export type TagScanState =
	| { kind: "idle" }
	| { kind: "scanning"; scope: TagScanScope }
	| { kind: "failed"; scope: TagScanScope; message: string }
	| {
			kind: "scanned";
			scope: TagScanScope;
			tagsByPath: TagsByPath;
			/** Last-seen mtime per path; the diff that keeps a refocus free. */
			mtimeByPath: Record<string, number>;
	  };

/** The listing fields the scan diff needs. */
export type TagScanFile = { path: string; modifiedAt: number };

export const tagScanStore = store<TagScanState>({ kind: "idle" });

function scopeOf(state: TagScanState): TagScanScope | undefined {
	return state.kind === "idle" ? undefined : state.scope;
}

/**
 * Enters the pending state for a workspace.
 *
 * An incremental rescan of a workspace already scanned deliberately does NOT
 * fall back to "scanning": the list is already correct and blanking it would
 * flash every group away on each window refocus (EC-61). Only a workspace with
 * no map yet shows the pending state.
 */
export function beginTagScan(scope: TagScanScope) {
	tagScanStore.set((state) =>
		state.kind === "scanned" && state.scope === scope
			? state
			: { kind: "scanning", scope },
	);
}

/**
 * A9: a failed scan is representable and readable. Ignored when the workspace
 * has already moved on, so a late rejection cannot paint an error over the
 * workspace the user switched to.
 */
export function failTagScan(scope: TagScanScope, message: string) {
	tagScanStore.set((state) =>
		scopeOf(state) === scope ? { kind: "failed", scope, message } : state,
	);
}

/**
 * Which paths a scan actually has to read.
 *
 * Everything, when there is no map for this workspace yet; otherwise only paths
 * that are new or whose mtime moved. A window-focus refresh that changed
 * nothing returns an EMPTY array, so zero file heads are read (EC-61, EC-67).
 */
export function tagScanPathsToScan(
	state: TagScanState,
	scope: TagScanScope,
	files: readonly TagScanFile[],
): string[] {
	if (state.kind !== "scanned" || state.scope !== scope) {
		return files.map((file) => file.path);
	}
	return files
		.filter((file) => state.mtimeByPath[file.path] !== file.modifiedAt)
		.map((file) => file.path);
}

/**
 * Folds a scan result in.
 *
 * `scannedPaths` is what was REQUESTED and `tags` is what came back — the
 * scanner omits tagless paths, so a requested path missing from `tags` means
 * "this document has no tags", not "no data". `files` is the full listing the
 * diff was taken against, so paths that vanished from the workspace are dropped
 * rather than lingering in the map.
 *
 * Dropped outright when the store's scope no longer matches: a result for the
 * previous workspace can never be written as the current one's.
 */
export function completeTagScan({
	scope,
	files,
	scannedPaths,
	tags,
}: {
	scope: TagScanScope;
	files: readonly TagScanFile[];
	scannedPaths: readonly string[];
	tags: TagsByPath;
}) {
	tagScanStore.set((state) => {
		if (scopeOf(state) !== scope) return state;
		const previous =
			state.kind === "scanned" && state.scope === scope ? state.tagsByPath : {};
		const livePaths = new Set(files.map((file) => file.path));
		const tagsByPath: TagsByPath = {};
		for (const [path, pathTags] of Object.entries(previous)) {
			if (livePaths.has(path)) tagsByPath[path] = pathTags;
		}
		for (const path of scannedPaths) {
			const pathTags = tags[path];
			if (pathTags && pathTags.length > 0 && livePaths.has(path)) {
				tagsByPath[path] = pathTags;
			} else {
				delete tagsByPath[path];
			}
		}
		const mtimeByPath: Record<string, number> = {};
		for (const file of files) mtimeByPath[file.path] = file.modifiedAt;
		return { kind: "scanned", scope, tagsByPath, mtimeByPath };
	});
}

/**
 * Writes the tags for ONE path, from the list just written to disk.
 *
 * Upsert on a non-empty list, DELETE on an empty one (defect 16/31). It never
 * goes through the scan shape, because that shape cannot express "this document
 * now has no tags" — it simply omits such paths.
 *
 * Leaves `mtimeByPath` alone deliberately: the disk write bumps the real mtime,
 * so the next diff re-reads this one path. One redundant head read is the safe
 * side of that trade; a forged mtime would suppress a real external edit.
 */
export function upsertTagsForPath(path: string, tags: readonly string[]) {
	tagScanStore.set((state) => {
		if (state.kind !== "scanned") return state;
		const tagsByPath = { ...state.tagsByPath };
		if (tags.length > 0) tagsByPath[path] = [...tags];
		else delete tagsByPath[path];
		return { ...state, tagsByPath };
	});
}

/** Whether a tag map for THIS workspace exists — `buildNavRows`'s `tagsReady`. */
export function isTagScanReadyFor(
	state: TagScanState,
	scope: TagScanScope,
): boolean {
	return state.kind === "scanned" && state.scope === scope;
}

/** The map for this workspace, or null. Never another workspace's. */
export function tagsForScope(
	state: TagScanState,
	scope: TagScanScope,
): TagsByPath | null {
	return state.kind === "scanned" && state.scope === scope
		? state.tagsByPath
		: null;
}

/** Drops the map. For a closed workspace and for test isolation. */
export function resetTagScan() {
	tagScanStore.set({ kind: "idle" });
}
