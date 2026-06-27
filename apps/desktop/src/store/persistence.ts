import {
	type ContrastPreference,
	isContrastPreference,
	isThemePreference,
	type ThemePreference,
} from "../lib/theme";
import { emptyDoc, type SortMode } from "./state";
import { STORAGE_KEY } from "./storage";

type WorkspaceState = {
	workspacePath: string | null;
	recentWorkspaces: string[];
	lastOpenedPaths: Record<string, string>;
	sortMode: SortMode;
	files: { path: string; modified_at: number }[];
	folders: { path: string; modified_at: number }[];
	pinnedNotes: string[];
};

type DocumentState = ReturnType<typeof emptyDoc>;

type UiState = {
	sidebarOpen: boolean;
	isSwitcherOpen: boolean;
	themePreference: ThemePreference;
	contrastPreference: ContrastPreference;
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
	return {
		sidebarOpen: ui?.sidebarOpen ?? false,
		isSwitcherOpen: false,
		themePreference: isThemePreference(ui?.themePreference)
			? ui.themePreference
			: "system",
		contrastPreference: isContrastPreference(ui?.contrastPreference)
			? ui.contrastPreference
			: "standard",
	};
}

export function getInitialState(): DesktopState {
	const p = readStorage<Persisted>(STORAGE_KEY);
	return {
		workspace: hydrateWorkspace(p?.workspace),
		document: emptyDoc(p?.document?.lastOpenedPath ?? null),
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
		},
	};
}
