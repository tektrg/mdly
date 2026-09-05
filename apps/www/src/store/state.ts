import { store } from "@simplestack/store";
import { localStoragePersist } from "../lib/localStoragePersist";
import { readLastOpenedPaths, STORAGE_KEY, serialize } from "./persistence";

export type FileEntry = {
	path: string;
	contentHash: string;
	updatedAt: number;
	deleted: boolean;
};

export type AssetEntry = {
	path: string;
	storageId: string;
	contentHash: string;
	updatedAt: number;
	deleted: boolean;
};

type ViewerStatus = "idle" | "loading" | "ready" | "error";

/**
 * R31: apps/www's editor is read-only, so a local edit can never diverge
 * from the remote copy — there is no "conflict" kind here (unlike the
 * desktop app's editable ExternalChange union). "deleted" is the only
 * remote-state banner left: purely informational (the file the browser is
 * looking at was removed on the Mac), not a save/conflict-resolution path.
 */
export type ExternalChange = { kind: "none" } | { kind: "deleted" };

const NO_EXTERNAL_CHANGE: ExternalChange = { kind: "none" };

export type ViewerState = {
	currentPath: string | null;
	pendingPath: string | null;
	content: string;
	basedOnHash: string | null;
	externalChange: ExternalChange;
	status: ViewerStatus;
	error: string | null;
};

export type WorkspaceState = {
	snapshot: { id: string; name: string } | null;
	files: FileEntry[];
	assets: AssetEntry[];
	filesLoaded: boolean;
	lastOpenedPaths: Record<string, string>;
	status: "idle" | "loading" | "ready" | "error";
	error: string | null;
};

export type AppState = {
	workspace: WorkspaceState;
	viewer: ViewerState;
};

function getInitialState(
	lastOpenedPaths: Record<string, string> = readLastOpenedPaths(),
): AppState {
	return {
		workspace: {
			snapshot: null,
			files: [],
			assets: [],
			filesLoaded: false,
			lastOpenedPaths,
			status: "idle",
			error: null,
		},
		viewer: {
			currentPath: null,
			pendingPath: null,
			content: "",
			basedOnHash: null,
			externalChange: NO_EXTERNAL_CHANGE,
			status: "idle",
			error: null,
		},
	};
}

const initialState: AppState = getInitialState();

export const appStore = store<AppState>(initialState, {
	middleware: [localStoragePersist(STORAGE_KEY, serialize)],
});

export const workspaceStore = appStore.select("workspace");
export const viewerStore = appStore.select("viewer");
export const filesStore = workspaceStore.select("files");
export const assetsStore = workspaceStore.select("assets");
export const filesLoadedStore = workspaceStore.select("filesLoaded");
export const currentPathStore = viewerStore.select("currentPath");
export const pendingPathStore = viewerStore.select("pendingPath");

export function resetState(): void {
	appStore.set(getInitialState(appStore.get().workspace.lastOpenedPaths));
}
