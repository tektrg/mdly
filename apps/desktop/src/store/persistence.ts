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

type WorkspaceState = {
	workspacePath: string | null;
	recentWorkspaces: string[];
	lastOpenedPaths: Record<string, string>;
	sortMode: SortMode;
	files: WorkspaceEntry[];
	folders: WorkspaceEntry[];
	pinnedNotes: string[];
};

type WorkspaceEntry = {
	path: string;
	modified_at: number;
	is_symlink?: boolean;
	symlink_target?: string | null;
	symlink_target_exists?: boolean;
	symlink_target_in_workspace?: boolean;
	symlink_canonical_path?: string | null;
};

type DocumentState = {
	currentPath: string | null;
	lastOpenedPath: string | null;
	content: string;
	diskContent: string;
	externalChange:
		| { kind: "none" }
		| { kind: "conflict"; diskContent: string }
		| { kind: "review"; diskContent: string };
	status: "idle" | "loading" | "ready" | "error";
	error: string | null;
};

type UiState = {
	sidebarOpen: boolean;
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
		sortMode: ws?.sortMode === "alpha" ? "alpha" : "recent",
		files: [],
		folders: [],
		pinnedNotes: [],
	};
}

function hydrateUi(ui: Persisted["ui"]): UiState {
	const editorFontPreference =
		normalizeEditorFontPreference(ui?.editorFontPreference) ??
		SYSTEM_EDITOR_FONT_PREFERENCE;

	return {
		sidebarOpen: ui?.sidebarOpen ?? false,
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
