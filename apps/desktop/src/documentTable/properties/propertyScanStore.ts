import { store } from "@simplestack/store";
import type {
	FrontMatterPropertyScan,
	ScannedFrontMatterProperty,
} from "../../desktopApi/types";
import type { PropertiesByPath } from "./propertyFields";

/**
 * The workspace's front-matter properties, read in the background (design note
 * phase 2). Same shape of reasoning as `tagScanStore.ts`:
 *
 * - The workspace scope lives INSIDE the value, so a late result for the
 *   previous workspace is dropped, never shown as the current one's.
 * - The cache is keyed by `(path, mtime)`: a refocus or a save re-reads only
 *   the files whose mtime moved, so a 50k workspace pays the cold read once per
 *   session. (Keyed on mtime alone: the listing carries no size. The disposable
 *   on-disk cache index of decision A is phase 4.)
 * - The scan never blocks typing: head reads run in the main process, and
 *   results land in a few large batches rather than per file.
 */
export type PropertyScanState = {
	scope: string | null;
	status: "idle" | "scanning" | "ready" | "failed";
	failureMessage: string | null;
	propertiesByPath: PropertiesByPath;
	/** Last-read mtime per path; the diff that keeps a refocus free. */
	mtimeByPath: Readonly<Record<string, number>>;
	/** Files whose front matter could not be parsed — surfaced, never hidden. */
	invalidPaths: readonly string[];
	/** Progress of the running scan, for the status line. */
	scannedCount: number;
	pendingCount: number;
};

const EMPTY_STATE: PropertyScanState = {
	scope: null,
	status: "idle",
	failureMessage: null,
	propertiesByPath: {},
	mtimeByPath: {},
	invalidPaths: [],
	scannedCount: 0,
	pendingCount: 0,
};

export const propertyScanStore = store<PropertyScanState>(EMPTY_STATE);

/**
 * Paths per IPC call. Large on purpose: each batch re-infers the schema and
 * re-projects every row, so 50k files land in 10 renderer updates, not 50k.
 */
export const PROPERTY_SCAN_BATCH_SIZE = 5000;

export type PropertyScanFile = { path: string; modifiedAt: number };

export type ScanFrontMatterProperties = (
	paths: string[],
) => Promise<FrontMatterPropertyScan>;

/** Paths that are new or whose mtime moved since the last read of this workspace. */
export function propertyPathsToScan(
	state: PropertyScanState,
	scope: string | null,
	files: readonly PropertyScanFile[],
): string[] {
	if (state.scope !== scope) return files.map((file) => file.path);
	return files
		.filter((file) => state.mtimeByPath[file.path] !== file.modifiedAt)
		.map((file) => file.path);
}

/**
 * Folds one batch in. `requested` are the paths asked for; a requested path
 * missing from the result means "no properties now" (deleted from the file, or
 * the file vanished), so its old values are dropped rather than lingering.
 */
export function mergePropertyBatch(
	state: PropertyScanState,
	requested: readonly PropertyScanFile[],
	result: FrontMatterPropertyScan,
): PropertyScanState {
	const propertiesByPath: Record<
		string,
		Readonly<Record<string, ScannedFrontMatterProperty>>
	> = { ...state.propertiesByPath };
	const mtimeByPath: Record<string, number> = { ...state.mtimeByPath };
	const invalid = new Set(state.invalidPaths);
	for (const file of requested) {
		const properties = result.propertiesByPath[file.path];
		if (properties) propertiesByPath[file.path] = properties;
		else delete propertiesByPath[file.path];
		invalid.delete(file.path);
		mtimeByPath[file.path] = file.modifiedAt;
	}
	for (const path of result.invalidPaths) invalid.add(path);
	return {
		...state,
		propertiesByPath,
		mtimeByPath,
		invalidPaths: [...invalid],
		scannedCount: state.scannedCount + requested.length,
	};
}

/** Drops every path no longer in the listing (deleted or renamed away). */
export function prunePropertyState(
	state: PropertyScanState,
	files: readonly PropertyScanFile[],
): PropertyScanState {
	const live = new Set(files.map((file) => file.path));
	const isStale = (path: string) => !live.has(path);
	const stalePaths = Object.keys(state.mtimeByPath).filter(isStale);
	const staleInvalid = state.invalidPaths.some(isStale);
	if (stalePaths.length === 0 && !staleInvalid) return state;
	const propertiesByPath = { ...state.propertiesByPath };
	const mtimeByPath = { ...state.mtimeByPath };
	for (const path of stalePaths) {
		delete propertiesByPath[path];
		delete mtimeByPath[path];
	}
	return {
		...state,
		propertiesByPath,
		mtimeByPath,
		invalidPaths: state.invalidPaths.filter((path) => live.has(path)),
	};
}

/** How often a long scan shows its partial results. */
const PUBLISH_INTERVAL_MS = 1500;

let scanGeneration = 0;
/** Merged batches not yet in the store; survives a superseding run of the same scope. */
let unpublishedWork: PropertyScanState | null = null;

/**
 * Brings the store up to date with `files` for `scope`: prunes vanished paths,
 * then reads only new/changed heads in batches. A newer call (another listing,
 * another workspace) supersedes a running one at its next batch boundary.
 */
export async function runPropertyScan(
	scope: string | null,
	files: readonly PropertyScanFile[],
	scan: ScanFrontMatterProperties,
): Promise<void> {
	const generation = ++scanGeneration;
	const isCurrent = () =>
		generation === scanGeneration && propertyScanStore.get().scope === scope;

	// A superseded run's merged-but-unpublished batches are kept, so a burst
	// of saves during a cold scan never re-reads what was already read.
	const carried = unpublishedWork?.scope === scope ? unpublishedWork : null;
	unpublishedWork = null;
	propertyScanStore.set((state) =>
		state.scope === scope
			? prunePropertyState(carried ?? state, files)
			: { ...EMPTY_STATE, scope },
	);
	const fileByPath = new Map(files.map((file) => [file.path, file]));
	const pending = propertyPathsToScan(propertyScanStore.get(), scope, files)
		.map((path) => fileByPath.get(path))
		.filter((file): file is PropertyScanFile => file !== undefined);
	if (pending.length === 0) {
		propertyScanStore.set((state) =>
			state.status === "ready" ? state : { ...state, status: "ready" },
		);
		return;
	}

	propertyScanStore.set((state) => ({
		...state,
		status: "scanning",
		failureMessage: null,
		scannedCount: 0,
		pendingCount: pending.length,
	}));
	try {
		// Batches merge into a private copy; the shared map (which every
		// consumer re-infers and re-projects from) is published at most every
		// PUBLISH_INTERVAL_MS, so a cold 50k scan costs the renderer a handful
		// of re-inferences instead of one per batch. Progress counts still tick.
		let working = propertyScanStore.get();
		let lastPublishAt = Date.now();
		for (
			let start = 0;
			start < pending.length;
			start += PROPERTY_SCAN_BATCH_SIZE
		) {
			const batch = pending.slice(start, start + PROPERTY_SCAN_BATCH_SIZE);
			const result = await scan(batch.map((file) => file.path));
			if (!isCurrent()) return;
			working = mergePropertyBatch(working, batch, result);
			unpublishedWork = working;
			const isLast = start + PROPERTY_SCAN_BATCH_SIZE >= pending.length;
			if (isLast) break;
			if (Date.now() - lastPublishAt >= PUBLISH_INTERVAL_MS) {
				lastPublishAt = Date.now();
				const published = working;
				propertyScanStore.set(() => published);
			} else {
				const { scannedCount } = working;
				propertyScanStore.set((state) => ({ ...state, scannedCount }));
			}
		}
		if (!isCurrent()) return;
		const finished = working;
		unpublishedWork = null;
		propertyScanStore.set(() => ({ ...finished, status: "ready" }));
	} catch (error) {
		if (!isCurrent()) return;
		propertyScanStore.set((state) => ({
			...state,
			status: "failed",
			failureMessage: error instanceof Error ? error.message : String(error),
		}));
	}
}

/** Test seam and workspace close: forget everything. */
export function resetPropertyScan() {
	scanGeneration += 1;
	unpublishedWork = null;
	propertyScanStore.set(EMPTY_STATE);
}
