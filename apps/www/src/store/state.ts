import { store } from "@simplestack/store";
import { localStoragePersist } from "../lib/localStoragePersist";
import { readLastOpenedPaths, STORAGE_KEY, serialize } from "./persistence";
import type { SidecarEntry } from "./sidecars";

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
 * Remote-state banner for the open file. The viewer is writable (web
 * write-back), so a remote change CAN race a local edit: when our guarded
 * push is rejected (409), the loser's words are preserved in a conflict copy
 * and this flips to "conflict" until the user reloads. "deleted" stays
 * purely informational: the open file was removed on the Mac.
 */
export type ExternalChange =
	| { kind: "none" }
	| { kind: "deleted" }
	| { kind: "conflict"; copyPath: string };

const NO_EXTERNAL_CHANGE: ExternalChange = { kind: "none" };

export type ViewerState = {
	currentPath: string | null;
	pendingPath: string | null;
	content: string;
	basedOnHash: string | null;
	externalChange: ExternalChange;
	status: ViewerStatus;
	error: string | null;
	/**
	 * Last failed web save, if any. Kept separate from `error` on purpose:
	 * a failed push must never flip `status` to "error" (that would unmount
	 * the editor). The banner dismisses on the next successful push, and
	 * the next keystroke re-stages a push anyway (auto-retry).
	 */
	saveError: string | null;
};

export type WorkspaceState = {
	snapshot: { id: string; name: string } | null;
	files: FileEntry[];
	assets: AssetEntry[];
	/**
	 * Synced sidecar rows (comment logs + history index) WITH content,
	 * keyed by remote path. Partitioned out of `files` on every ingestion
	 * path, so the sidebar never sees them. Tombstoned rows excluded.
	 */
	sidecars: Record<string, SidecarEntry>;
	/**
	 * Bumped ONLY when sidecar content actually moves (hash comparison),
	 * never on a redundant broadcast — comment surfaces memoize on this.
	 */
	commentsVersion: number;
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
			sidecars: {},
			commentsVersion: 0,
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
			saveError: null,
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
