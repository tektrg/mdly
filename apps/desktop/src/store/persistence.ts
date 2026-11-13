import type { DocumentTableSort } from "../documentTable/documentTableView";
import type { NavGroupExpansion } from "../documentTable/navExpandedGroups";
import {
	isDocumentTableSortColumn,
	sanitizeDocumentViews,
	type WorkspaceDocumentViews,
} from "../documentTable/properties/documentViews";
import {
	type ContrastPreference,
	type EditorFontPreference,
	isContrastPreference,
	isThemePreference,
	normalizeEditorFontPreference,
	SYSTEM_EDITOR_FONT_PREFERENCE,
	type ThemePreference,
} from "../lib/theme";
import type { SortMode } from "./state";
import { STORAGE_KEY } from "./storage";

export type SourceRetentionPreference = "ask" | "keep" | "delete";

export function isSourceRetentionPreference(
	value: unknown,
): value is SourceRetentionPreference {
	return value === "ask" || value === "keep" || value === "delete";
}

type NavViewSorts = Partial<Record<string, DocumentTableSort>>;

type WorkspaceState = {
	workspacePath: string | null;
	recentWorkspaces: string[];
	lastOpenedPaths: Record<string, string>;
	/**
	 * R13: the peek list's desired width per workspace path. The RENDERED width
	 * is `clampPeekListWidth` applied to this desire at render time, so a narrow
	 * window clamps without rewriting the user's choice (EC-30). Same
	 * per-workspace-map shape as `lastOpenedPaths`, persisted through the same
	 * `localStoragePersist` middleware — no second mechanism.
	 */
	peekListWidths: Record<string, number>;
	/**
	 * Group collapse state per workspace → view+grouping scope → group id,
	 * stored as deviations from the default (see `navExpandedGroups.ts`).
	 * Local per-machine pref, never written to `.hubble/views.json`.
	 */
	navGroupExpansion: NavGroupExpansion;
	/**
	 * A12: views hidden from the Rail dot strip, per workspace. Empty means
	 * both dots show. Same per-workspace-map shape and middleware as the maps
	 * above; no second mechanism.
	 */
	navHiddenViews: Record<string, string[]>;
	/**
	 * The document list's sort, remembered per view ("recent" | "folder" |
	 * "tag") per workspace. A missing entry means the shared default sort.
	 * Same per-workspace-map shape and middleware as `navHiddenViews`.
	 */
	navViewSorts: Record<string, NavViewSorts>;
	/**
	 * Saved views R3: the saved view selected in the view switcher, per
	 * workspace, so it is restored after restart. Only ids — never stored in
	 * `navHiddenViews` (R4).
	 */
	selectedSavedViews: Record<string, string>;
	/**
	 * The unsaved view's property columns, per workspace. `saved` here is
	 * LEGACY only: saved views now live in `<workspace>/.hubble/views.json`
	 * (`documentViewsFileStore.ts`), which imports and then empties it.
	 */
	documentViews: Record<string, WorkspaceDocumentViews>;
	sortMode: SortMode;
	files: WorkspaceEntry[];
	folders: WorkspaceEntry[];
	pinnedNotes: string[];
	/**
	 * R8: `files: []` alone cannot tell "still scanning" from "scan failed" from
	 * "genuinely empty". A home screen that renders a deleted / unmounted /
	 * permission-revoked workspace as a confident "no documents" is a lie, so
	 * `refreshFiles` records whether a listing has completed at least once for
	 * the current workspace and why the last one failed. Runtime-only: neither
	 * field is in `Persisted`/`serialize`, so a stale error can never be rehydrated.
	 */
	hasListedOnce: boolean;
	listingError: string | null;
};

type WorkspaceEntry = {
	path: string;
	modified_at: number;
	created_at?: number;
	is_symlink?: boolean;
	symlink_target?: string | null;
	symlink_target_exists?: boolean;
	symlink_target_in_workspace?: boolean;
	symlink_canonical_path?: string | null;
};

type DocumentState = {
	/**
	 * The document the main panel is showing or trying to show; `null` means the
	 * full-width document table is home. Written only by `loadPath` (synchronously,
	 * before its first `await`) and cleared only by `emptyDoc`/`emptyPersistedDoc`,
	 * so every open- and close-door inherits the layout without per-caller wiring.
	 * Deliberately absent from `Persisted`/`serialize` — that omission IS the
	 * guarantee that a relaunch always lands on the table (R1).
	 */
	requestedPath: string | null;
	currentPath: string | null;
	lastOpenedPath: string | null;
	content: string;
	diskContent: string;
	externalChange:
		| { kind: "none" }
		| { kind: "applied"; previousContent: string };
	status: "idle" | "loading" | "ready" | "error";
	error: string | null;
};

type UiState = {
	/**
	 * Strict single-file window: a document open with no workspace.
	 * Runtime-only (same in-state/not-in-serialize pattern as
	 * `sidebarAutoCollapsed`/`isSwitcherOpen`) — a single-file window must
	 * never persist its emptied workspace over the remembered one.
	 */
	singleFileWindow: boolean;
	/** Runtime-only: always starts hidden, never serialized. */
	sidebarOpen: boolean;
	/**
	 * R3: runtime-only "the sidebar was auto-collapsed to make room for a document
	 * on a narrow window". Kept separate from `sidebarOpen` (which is persisted) so
	 * a transient narrow-window collapse can never rewrite the user's saved
	 * preference. Same in-state/not-in-serialize pattern as `isSwitcherOpen`.
	 */
	sidebarAutoCollapsed: boolean;
	isSwitcherOpen: boolean;
	themePreference: ThemePreference;
	contrastPreference: ContrastPreference;
	editorFontPreference: EditorFontPreference;
	showIgnoredWorkspaceFiles: boolean;
	sourceRetentionPreference: SourceRetentionPreference;
};

export type DesktopState = {
	workspace: WorkspaceState;
	document: DocumentState;
	ui: UiState;
};

type Persisted = {
	workspace?: {
		workspacePath?: string | null;
		recentWorkspaces?: string[];
		lastOpenedPaths?: Record<string, string>;
		peekListWidths?: Record<string, number>;
		navGroupExpansion?: unknown;
		navHiddenViews?: Record<string, string[]>;
		navViewSorts?: Record<string, NavViewSorts>;
		selectedSavedViews?: unknown;
		documentViews?: unknown;
		sortMode?: SortMode;
	};
	document?: { lastOpenedPath?: string | null };
	ui?: {
		themePreference?: unknown;
		contrastPreference?: unknown;
		editorFontPreference?: unknown;
		showIgnoredWorkspaceFiles?: boolean;
		sourceRetentionPreference?: unknown;
	};
};

function readStorage<T>(key: string): T | null {
	if (typeof localStorage === "undefined") return null;
	const raw = localStorage.getItem(key);
	if (!raw) return null;

	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

/**
 * Keeps only finite positive widths: a hand-edited or older-version value is a
 * legal record, not corruption, so bad entries are dropped and the rest kept.
 */
function sanitizePeekListWidths(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const widths: Record<string, number> = {};
	for (const [workspacePath, width] of Object.entries(
		value as Record<string, unknown>,
	)) {
		if (typeof width === "number" && Number.isFinite(width) && width > 0) {
			widths[workspacePath] = width;
		}
	}
	return widths;
}

/**
 * Keeps only string-id arrays: same "legal record, drop bad entries" rule as
 * the width map above.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Keeps only boolean entries; the old flat `navExpandedGroups` is dropped. */
function sanitizeNavGroupExpansion(value: unknown): NavGroupExpansion {
	if (!isPlainObject(value)) return {};
	const out: NavGroupExpansion = {};
	for (const [workspacePath, scopes] of Object.entries(value)) {
		if (!isPlainObject(scopes)) continue;
		const kept: NavGroupExpansion[string] = {};
		for (const [scope, overrides] of Object.entries(scopes)) {
			if (!isPlainObject(overrides)) continue;
			const ids: Record<string, boolean> = {};
			for (const [id, expanded] of Object.entries(overrides)) {
				if (typeof expanded === "boolean") ids[id] = expanded;
			}
			kept[scope] = ids;
		}
		out[workspacePath] = kept;
	}
	return out;
}

/**
 * Keeps only the two engine group-by values: anything else in the record is
 * dropped, an all-dropped workspace reads as "nothing hidden".
 */
function sanitizeNavHiddenViews(value: unknown): Record<string, string[]> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const hidden: Record<string, string[]> = {};
	for (const [workspacePath, views] of Object.entries(
		value as Record<string, unknown>,
	)) {
		if (!Array.isArray(views)) continue;
		const kept = [...new Set(views)].filter(
			(view): view is string => view === "folder" || view === "tag",
		);
		if (kept.length > 0) hidden[workspacePath] = kept;
	}
	return hidden;
}

/** Keeps only non-empty string ids keyed by workspace path. */
function sanitizeSelectedSavedViews(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const selected: Record<string, string> = {};
	for (const [workspacePath, id] of Object.entries(
		value as Record<string, unknown>,
	)) {
		if (typeof id === "string" && id.length > 0) selected[workspacePath] = id;
	}
	return selected;
}

function isValidNavViewSort(value: unknown): value is DocumentTableSort {
	if (!value || typeof value !== "object") return false;
	const { column, direction } = value as Record<string, unknown>;
	return (
		isDocumentTableSortColumn(column) &&
		(direction === "asc" || direction === "desc")
	);
}

/** Drops unknown views and malformed sorts; an all-dropped workspace is omitted. */
function sanitizeNavViewSorts(value: unknown): Record<string, NavViewSorts> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const sorts: Record<string, NavViewSorts> = {};
	for (const [workspacePath, byView] of Object.entries(
		value as Record<string, unknown>,
	)) {
		// A `__proto__` key from JSON.parse would reassign the map's prototype
		// instead of adding an entry.
		if (workspacePath === "__proto__") continue;
		if (!byView || typeof byView !== "object" || Array.isArray(byView)) {
			continue;
		}
		const kept: NavViewSorts = {};
		for (const view of ["recent", "folder", "tag"]) {
			const sort = (byView as Record<string, unknown>)[view];
			if (isValidNavViewSort(sort)) {
				kept[view] = { column: sort.column, direction: sort.direction };
			}
		}
		if (Object.keys(kept).length > 0) sorts[workspacePath] = kept;
	}
	return sorts;
}

function hydrateWorkspace(ws: Persisted["workspace"]): WorkspaceState {
	return {
		workspacePath: ws?.workspacePath ?? null,
		recentWorkspaces: Array.isArray(ws?.recentWorkspaces)
			? ws.recentWorkspaces
			: [],
		lastOpenedPaths:
			ws?.lastOpenedPaths &&
			typeof ws.lastOpenedPaths === "object" &&
			!Array.isArray(ws.lastOpenedPaths)
				? ws.lastOpenedPaths
				: {},
		peekListWidths: sanitizePeekListWidths(ws?.peekListWidths),
		navGroupExpansion: sanitizeNavGroupExpansion(ws?.navGroupExpansion),
		navHiddenViews: sanitizeNavHiddenViews(ws?.navHiddenViews),
		navViewSorts: sanitizeNavViewSorts(ws?.navViewSorts),
		selectedSavedViews: sanitizeSelectedSavedViews(ws?.selectedSavedViews),
		documentViews: sanitizeDocumentViews(ws?.documentViews),
		sortMode: ws?.sortMode === "alpha" ? "alpha" : "recent",
		files: [],
		folders: [],
		pinnedNotes: [],
		hasListedOnce: false,
		listingError: null,
	};
}

function hydrateUi(ui: Persisted["ui"]): UiState {
	const editorFontPreference =
		normalizeEditorFontPreference(ui?.editorFontPreference) ??
		SYSTEM_EDITOR_FONT_PREFERENCE;

	return {
		singleFileWindow: false,
		// The document table is the main navigation; the sidebar is opt-in per
		// session (pill / Cmd+Shift+E), so a saved `sidebarOpen` is never restored.
		sidebarOpen: false,
		sidebarAutoCollapsed: false,
		isSwitcherOpen: false,
		themePreference: isThemePreference(ui?.themePreference)
			? ui.themePreference
			: "system",
		contrastPreference: isContrastPreference(ui?.contrastPreference)
			? ui.contrastPreference
			: "standard",
		editorFontPreference,
		showIgnoredWorkspaceFiles: ui?.showIgnoredWorkspaceFiles === true,
		sourceRetentionPreference: isSourceRetentionPreference(
			ui?.sourceRetentionPreference,
		)
			? ui.sourceRetentionPreference
			: "ask",
	};
}

function emptyPersistedDoc(
	lastOpenedPath: string | null = null,
): DocumentState {
	return {
		requestedPath: null,
		currentPath: null,
		lastOpenedPath,
		content: "",
		diskContent: "",
		externalChange: { kind: "none" },
		status: "idle",
		error: null,
	};
}

export function getInitialState(): DesktopState {
	const p = readStorage<Persisted>(STORAGE_KEY);
	return {
		workspace: hydrateWorkspace(p?.workspace),
		document: emptyPersistedDoc(p?.document?.lastOpenedPath ?? null),
		ui: hydrateUi(p?.ui),
	};
}

/**
 * A workspace slice with no workspace — what a strict single-file window
 * holds in memory so no ghost of the remembered workspace leaks into the UI.
 * Never persisted (see `serialize`): the remembered workspace on disk is
 * always kept.
 */
export function getEmptyWorkspaceState(): WorkspaceState {
	return hydrateWorkspace(undefined);
}

function serializeUi(ui: UiState): NonNullable<Persisted["ui"]> {
	return {
		themePreference: ui.themePreference,
		contrastPreference: ui.contrastPreference,
		editorFontPreference: ui.editorFontPreference,
		showIgnoredWorkspaceFiles: ui.showIgnoredWorkspaceFiles,
		sourceRetentionPreference: ui.sourceRetentionPreference,
	};
}

export function serialize(state: DesktopState): Persisted {
	// A single-file window holds an emptied workspace in memory. Persisting
	// that would wipe the remembered workspace (and its last-opened files)
	// for every other window and the next launch — so the workspace and
	// document sections are re-read from disk instead. UI prefs still save.
	// Read fresh on every call so a workspace window's newer persist is never
	// clobbered by this window's stale in-memory copy.
	if (state.ui.singleFileWindow) {
		const disk = readStorage<Persisted>(STORAGE_KEY) ?? {};
		return {
			workspace: disk.workspace,
			document: disk.document,
			ui: serializeUi(state.ui),
		};
	}
	return {
		workspace: {
			workspacePath: state.workspace.workspacePath,
			recentWorkspaces: state.workspace.recentWorkspaces,
			lastOpenedPaths: state.workspace.lastOpenedPaths,
			peekListWidths: state.workspace.peekListWidths,
			navGroupExpansion: state.workspace.navGroupExpansion,
			navHiddenViews: state.workspace.navHiddenViews,
			navViewSorts: state.workspace.navViewSorts,
			selectedSavedViews: state.workspace.selectedSavedViews,
			documentViews: state.workspace.documentViews,
			sortMode: state.workspace.sortMode,
		},
		document: {
			lastOpenedPath: state.document.lastOpenedPath,
		},
		ui: serializeUi(state.ui),
	};
}
