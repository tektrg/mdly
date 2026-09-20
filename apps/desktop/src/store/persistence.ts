import type { DocumentTableSort } from "../documentTable/documentTableView";
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
	 * R2: group expansion per workspace, as expanded group ids. Seeded from
	 * `defaultExpandedIds` when a workspace has no record yet — a missing
	 * record is "never toggled", not an error. Same per-workspace-map shape
	 * and middleware as `peekListWidths`; no second mechanism.
	 */
	navExpandedGroups: Record<string, string[]>;
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
		navExpandedGroups?: Record<string, string[]>;
		navHiddenViews?: Record<string, string[]>;
		navViewSorts?: Record<string, NavViewSorts>;
		sortMode?: SortMode;
	};
	document?: { lastOpenedPath?: string | null };
	ui?: {
		sidebarOpen?: boolean;
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
function sanitizeNavExpandedGroups(value: unknown): Record<string, string[]> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const groups: Record<string, string[]> = {};
	for (const [workspacePath, ids] of Object.entries(
		value as Record<string, unknown>,
	)) {
		if (
			Array.isArray(ids) &&
			ids.every((id): id is string => typeof id === "string")
		) {
			groups[workspacePath] = [...ids];
		}
	}
	return groups;
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

function isValidNavViewSort(value: unknown): value is DocumentTableSort {
	if (!value || typeof value !== "object") return false;
	const { column, direction } = value as Record<string, unknown>;
	return (
		(column === "name" ||
			column === "folder" ||
			column === "modified" ||
			column === "created") &&
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
		navExpandedGroups: sanitizeNavExpandedGroups(ws?.navExpandedGroups),
		navHiddenViews: sanitizeNavHiddenViews(ws?.navHiddenViews),
		navViewSorts: sanitizeNavViewSorts(ws?.navViewSorts),
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
		sidebarOpen: ui?.sidebarOpen ?? false,
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

export function serialize(state: DesktopState): Persisted {
	return {
		workspace: {
			workspacePath: state.workspace.workspacePath,
			recentWorkspaces: state.workspace.recentWorkspaces,
			lastOpenedPaths: state.workspace.lastOpenedPaths,
			peekListWidths: state.workspace.peekListWidths,
			navExpandedGroups: state.workspace.navExpandedGroups,
			navHiddenViews: state.workspace.navHiddenViews,
			navViewSorts: state.workspace.navViewSorts,
			sortMode: state.workspace.sortMode,
		},
		document: {
			lastOpenedPath: state.document.lastOpenedPath,
		},
		ui: {
			sidebarOpen: state.ui.sidebarOpen,
			themePreference: state.ui.themePreference,
			contrastPreference: state.ui.contrastPreference,
			editorFontPreference: state.ui.editorFontPreference,
			showIgnoredWorkspaceFiles: state.ui.showIgnoredWorkspaceFiles,
			sourceRetentionPreference: state.ui.sourceRetentionPreference,
		},
	};
}
