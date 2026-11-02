/**
 * The window's in-memory copy of each workspace's saved views, backed by a
 * `ViewStore` (desktop: `<workspace>/.hubble/views.json` via the main process;
 * elsewhere: localStorage). Saved views R11-R21.
 *
 * - Read on workspace open/switch; nothing is watched live (R21).
 * - Edits apply in memory at once and save after a short delay, to the
 *   workspace they were made in — a switch or quit flushes first (R20).
 * - Corrupt / unreadable file: built-ins only + a notice; never overwritten,
 *   except an explicit save, which goes through `resetCorrupt` (backup first) (R18).
 * - A refused (changed-on-disk) save re-reads and shows a conflict notice (R21);
 *   a failed save keeps the edit in memory, shows an error, never retries (R19).
 * - Legacy localStorage views migrate once per opened workspace; the legacy
 *   entry is cleared only after the file write succeeds (R15-R17).
 */
import { store } from "@simplestack/store";
import {
	type ExistingViewsState,
	emptyViewsFile,
	planLegacyMigration,
	type SavedViewRecord,
	serializeViewsFile,
	type ViewNameResult,
	type ViewStore,
	type ViewStoreReadResult,
	type ViewStoreSnapshot,
	type ViewsFile,
	validateViewName,
} from "@tektrg/table-core";
import { workspacePathStore, workspaceStore } from "../store/state";
import {
	MAX_SAVED_VIEW_NAME_LENGTH,
	type SavedDocumentView,
	sanitizeSavedView,
} from "./properties/documentViews";
import {
	createDesktopViewStore,
	createLocalStorageViewStore,
} from "./viewStores";

/** Names a saved view can never take (R2/R4): the built-in views. */
export const BUILT_IN_VIEW_NAMES: readonly string[] = [
	"Recent",
	"Folder",
	"Tag",
	"Tags",
	"All documents",
];

export const SAVED_VIEWS_SAVE_DELAY_MS = 400;

export type SavedViewsStatus =
	| "loading"
	| "ok"
	| "missing"
	| "corrupt"
	| "unreadable";

/** What the banner shows; null = nothing to say. */
export type SavedViewsNotice =
	| { kind: "corrupt"; reasons: string[] }
	| { kind: "unreadable"; error: string }
	| { kind: "skipped"; warnings: string[] }
	| { kind: "write-error"; error: string }
	| { kind: "conflict" };

export type SavedViewsSaveState =
	| "idle"
	| "pending"
	| "saving"
	| "saved"
	| "error";

export type WorkspaceSavedViews = {
	status: SavedViewsStatus;
	views: SavedDocumentView[];
	notice: SavedViewsNotice | null;
	saveState: SavedViewsSaveState;
};

const EMPTY: WorkspaceSavedViews = {
	status: "loading",
	views: [],
	notice: null,
	saveState: "idle",
};

/** Reactive per-workspace state (keyed by workspace path). */
export const savedViewsStore = store<Record<string, WorkspaceSavedViews>>({});

type Internal = {
	viewStore: ViewStore;
	/** Last file read/written: keeps unknown fields + unusable entries (R14). */
	base: ViewsFile | null;
	snapshot: ViewStoreSnapshot | null;
	rawById: Map<string, SavedViewRecord>;
	/** Entries table-core accepted but mdly cannot use; written back as-is. */
	unusable: unknown[];
	generation: number;
	loading: Promise<void> | null;
	timer: ReturnType<typeof setTimeout> | null;
	dirty: boolean;
	flushing: Promise<void>;
};

const internals = new Map<string, Internal>();

type ViewStoreFactory = (workspacePath: string) => ViewStore;

function defaultViewStoreFactory(workspacePath: string): ViewStore {
	const api = typeof window !== "undefined" ? window.desktopApi : undefined;
	if (api && typeof api.readWorkspaceViews === "function") {
		return createDesktopViewStore(api, workspacePath);
	}
	return createLocalStorageViewStore(globalThis.localStorage, workspacePath);
}

let viewStoreFactory: ViewStoreFactory = defaultViewStoreFactory;

/** Test seam: swap the storage adapter (and forget every loaded workspace). */
export function setViewStoreFactoryForTest(factory: ViewStoreFactory | null) {
	viewStoreFactory = factory ?? defaultViewStoreFactory;
	for (const internal of internals.values()) {
		if (internal.timer) clearTimeout(internal.timer);
	}
	internals.clear();
	savedViewsStore.set({});
}

function internalFor(workspacePath: string): Internal {
	let internal = internals.get(workspacePath);
	if (!internal) {
		internal = {
			viewStore: viewStoreFactory(workspacePath),
			base: null,
			snapshot: null,
			rawById: new Map(),
			unusable: [],
			generation: 0,
			loading: null,
			timer: null,
			dirty: false,
			flushing: Promise.resolve(),
		};
		internals.set(workspacePath, internal);
	}
	return internal;
}

function patch(workspacePath: string, next: Partial<WorkspaceSavedViews>) {
	savedViewsStore.set((all) => ({
		...all,
		[workspacePath]: { ...(all[workspacePath] ?? EMPTY), ...next },
	}));
}

export function getWorkspaceSavedViews(
	workspacePath: string | null,
): WorkspaceSavedViews {
	if (!workspacePath) return EMPTY;
	return savedViewsStore.get()[workspacePath] ?? EMPTY;
}

export function getSavedViews(
	workspacePath: string | null,
): SavedDocumentView[] {
	return getWorkspaceSavedViews(workspacePath).views;
}

/** Applies a successful read: mdly-valid views load, the rest is kept for saving. */
function applyFile(
	workspacePath: string,
	internal: Internal,
	file: ViewsFile,
	snapshot: ViewStoreSnapshot,
	warnings: readonly string[],
	status: "ok" = "ok",
) {
	const views: SavedDocumentView[] = [];
	const unusable: unknown[] = [];
	const skipped = [...warnings];
	internal.rawById = new Map();
	for (const record of file.views) {
		const view = sanitizeSavedView(record);
		if (view) {
			views.push(view);
			internal.rawById.set(view.id, record);
		} else {
			unusable.push(record);
			skipped.push(
				`view ${JSON.stringify(record.id)} skipped: not a usable view`,
			);
		}
	}
	internal.base = file;
	internal.snapshot = snapshot;
	internal.unusable = unusable;
	patch(workspacePath, {
		status,
		views,
		notice: skipped.length > 0 ? { kind: "skipped", warnings: skipped } : null,
	});
}

function applyRead(
	workspacePath: string,
	internal: Internal,
	result: ViewStoreReadResult,
) {
	switch (result.status) {
		case "ok":
			applyFile(
				workspacePath,
				internal,
				result.file,
				result.snapshot,
				result.warnings,
			);
			return;
		case "missing":
			internal.base = null;
			internal.snapshot = null;
			internal.rawById = new Map();
			internal.unusable = [];
			patch(workspacePath, { status: "missing", views: [], notice: null });
			return;
		case "corrupt":
			internal.base = null;
			internal.snapshot = result.snapshot;
			patch(workspacePath, {
				status: "corrupt",
				views: [],
				notice: { kind: "corrupt", reasons: result.reasons },
			});
			return;
		case "unreadable":
			internal.base = null;
			internal.snapshot = null;
			patch(workspacePath, {
				status: "unreadable",
				views: [],
				notice: { kind: "unreadable", error: result.error },
			});
	}
}

/** The file to write: in-memory views over their original records (unknown fields kept). */
function toFile(workspacePath: string, internal: Internal): ViewsFile {
	const base = internal.base ?? emptyViewsFile();
	return {
		...base,
		views: getSavedViews(workspacePath).map(
			(view) =>
				({
					...(internal.rawById.get(view.id) ?? {}),
					...view,
				}) as SavedViewRecord,
		),
		invalidViews: [...base.invalidViews, ...internal.unusable],
	};
}

function legacyViewsOf(workspacePath: string): SavedDocumentView[] {
	return workspaceStore.get().documentViews[workspacePath]?.saved ?? [];
}

function clearLegacyViews(workspacePath: string) {
	workspaceStore.set((state) => {
		const entry = state.documentViews[workspacePath];
		if (!entry || entry.saved.length === 0) return state;
		return {
			...state,
			documentViews: {
				...state.documentViews,
				[workspacePath]: { ...entry, saved: [] },
			},
		};
	});
}

/** One-time per-workspace import of the old localStorage views (R15-R17). */
async function migrateLegacy(
	workspacePath: string,
	internal: Internal,
	read: ViewStoreReadResult,
) {
	const legacy = legacyViewsOf(workspacePath);
	if (legacy.length === 0) return;
	const existing: ExistingViewsState =
		read.status === "ok"
			? { kind: "ok", file: read.file }
			: read.status === "missing"
				? { kind: "missing" }
				: { kind: read.status };
	const plan = planLegacyMigration(
		existing,
		legacy as unknown as SavedViewRecord[],
		{
			builtInNames: BUILT_IN_VIEW_NAMES,
			maxLength: MAX_SAVED_VIEW_NAME_LENGTH,
		},
	);
	if (plan.action === "keep-legacy") return;
	if (plan.action === "nothing") return;
	if (
		read.status === "ok" &&
		serializeViewsFile(plan.file) === serializeViewsFile(read.file)
	) {
		// Already imported (a previous run wrote but could not clear): no write.
		clearLegacyViews(workspacePath);
		return;
	}
	const result = await internal.viewStore.write(
		plan.file,
		read.status === "ok" ? read.snapshot : null,
	);
	if (result.status === "ok") {
		applyFile(workspacePath, internal, plan.file, result.snapshot, []);
		clearLegacyViews(workspacePath);
		return;
	}
	// Legacy stays put and the next open retries.
	if (result.status === "error") {
		patch(workspacePath, {
			notice: { kind: "write-error", error: result.error },
		});
	}
}

/**
 * (Re-)reads a workspace's views. Migration runs on open/switch only, never
 * on the re-read after a conflict.
 */
export function loadWorkspaceSavedViews(
	workspacePath: string,
	options: { migrate?: boolean } = {},
): Promise<void> {
	const internal = internalFor(workspacePath);
	const generation = ++internal.generation;
	if (!savedViewsStore.get()[workspacePath]) patch(workspacePath, EMPTY);
	else patch(workspacePath, { status: "loading" });
	const loading = (async () => {
		let read: ViewStoreReadResult;
		try {
			read = await internal.viewStore.read();
		} catch (error) {
			read = { status: "unreadable", error: String(error) };
		}
		if (generation !== internal.generation) return;
		applyRead(workspacePath, internal, read);
		if (options.migrate !== false) {
			await migrateLegacy(workspacePath, internal, read);
		}
	})();
	internal.loading = loading;
	return loading.finally(() => {
		if (internal.loading === loading) internal.loading = null;
	});
}

/**
 * Applies an edit to a workspace's saved views in memory and schedules the
 * save. An edit made while the file is still loading lands after the load,
 * so it never races the read.
 */
export function updateSavedViews(
	workspacePath: string,
	update: (views: SavedDocumentView[]) => SavedDocumentView[],
): void {
	const internal = internalFor(workspacePath);
	const apply = () => {
		const current = getSavedViews(workspacePath);
		const next = update(current);
		if (next === current) return;
		internal.dirty = true;
		patch(workspacePath, { views: next, saveState: "pending" });
		if (internal.timer) clearTimeout(internal.timer);
		internal.timer = setTimeout(() => {
			void flushSavedViews(workspacePath);
		}, SAVED_VIEWS_SAVE_DELAY_MS);
	};
	if (internal.loading) void internal.loading.then(apply);
	else apply();
}

/** Saves a workspace's pending edit now (switch/quit/tests). */
export function flushSavedViews(workspacePath: string): Promise<void> {
	const internal = internals.get(workspacePath);
	if (!internal) return Promise.resolve();
	if (internal.timer) {
		clearTimeout(internal.timer);
		internal.timer = null;
	}
	internal.flushing = internal.flushing.then(async () => {
		if (internal.loading) await internal.loading;
		if (!internal.dirty) return;
		internal.dirty = false;
		await save(workspacePath, internal);
	});
	return internal.flushing;
}

export function flushAllSavedViews(): Promise<void> {
	return Promise.all([...internals.keys()].map(flushSavedViews)).then(
		() => undefined,
	);
}

async function save(workspacePath: string, internal: Internal) {
	const { status } = getWorkspaceSavedViews(workspacePath);
	const file = toFile(workspacePath, internal);
	patch(workspacePath, { saveState: "saving" });
	let result: Awaited<ReturnType<ViewStore["write"]>>;
	try {
		result =
			status === "corrupt" && internal.viewStore.resetCorrupt
				? await internal.viewStore.resetCorrupt(file)
				: await internal.viewStore.write(file, internal.snapshot);
	} catch (error) {
		result = { status: "error", error: String(error) };
	}
	if (result.status === "ok") {
		// The unusable entries now live in base.invalidViews.
		internal.base = file;
		internal.snapshot = result.snapshot;
		internal.unusable = [];
		internal.rawById = new Map(file.views.map((record) => [record.id, record]));
		const { notice } = getWorkspaceSavedViews(workspacePath);
		patch(workspacePath, {
			status: "ok",
			saveState: internal.dirty ? "pending" : "saved",
			notice: notice?.kind === "skipped" ? notice : null,
		});
		return;
	}
	if (result.status === "conflict") {
		// The newer file wins: re-read it (no migration) and say so.
		await loadWorkspaceSavedViews(workspacePath, { migrate: false });
		patch(workspacePath, { notice: { kind: "conflict" }, saveState: "error" });
		return;
	}
	// The edit stays in memory for this session; no retry loop (R19).
	patch(workspacePath, {
		notice: { kind: "write-error", error: result.error },
		saveState: "error",
	});
}

/** Hides the banner (the condition it described may still hold). */
export function dismissSavedViewsNotice(workspacePath: string) {
	patch(workspacePath, { notice: null });
}

/**
 * Explicit "start fresh" for a corrupt file (R18): backs it up, then writes
 * the in-memory views (usually none).
 */
export function resetCorruptSavedViews(workspacePath: string): Promise<void> {
	const internal = internalFor(workspacePath);
	internal.dirty = true;
	patch(workspacePath, { status: "corrupt" });
	return flushSavedViews(workspacePath);
}

/** R2 name rules for a new or renamed saved view. */
export function validateSavedViewName(
	workspacePath: string | null,
	name: string,
	selfId?: string,
): ViewNameResult {
	return validateViewName(name, {
		existing: getSavedViews(workspacePath),
		builtInNames: BUILT_IN_VIEW_NAMES,
		maxLength: MAX_SAVED_VIEW_NAME_LENGTH,
		selfId,
	});
}

// --- workspace lifecycle --------------------------------------------------

let currentWorkspace: string | null = null;

function onWorkspace(next: string | null) {
	const previous = currentWorkspace;
	if (previous === next) return;
	currentWorkspace = next;
	// The pending edit belongs to the workspace it was made in (R20).
	if (previous) void flushSavedViews(previous);
	if (next) void loadWorkspaceSavedViews(next);
}

onWorkspace(workspacePathStore.get() ?? null);
workspacePathStore.subscribe((next) => onWorkspace(next ?? null));

if (
	typeof window !== "undefined" &&
	typeof window.addEventListener === "function"
) {
	window.addEventListener("beforeunload", () => {
		void flushAllSavedViews();
	});
	// R20: the reliable path — main holds the close until this resolves.
	window.desktopApi?.onFlushPendingSaves?.(flushAllSavedViews);
}
