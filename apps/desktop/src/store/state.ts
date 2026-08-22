import { store } from "@simplestack/store";
import type { FileAction } from "../externalFileChange";
import { localStoragePersist } from "../lib/localStoragePersist";
import { type DesktopState, getInitialState, serialize } from "./persistence";
import { STORAGE_KEY } from "./storage";
import { recordStormEvent } from "./stormDetector";

export type SortMode = "alpha" | "recent";

export type FileEntry = {
	path: string;
	modified_at: number;
	is_symlink?: boolean;
	symlink_target?: string | null;
	symlink_target_exists?: boolean;
	symlink_target_in_workspace?: boolean;
	symlink_canonical_path?: string | null;
};

export type FolderEntry = FileEntry;

type ViewerStatus = "idle" | "loading" | "ready" | "error";
export type ExternalChange =
	| { kind: "none" }
	| { kind: "conflict"; diskContent: string }
	// A clean (no unsaved local edits) external edit, pending the user's
	// per-region accept/reject review. Unlike "conflict", this never wins a
	// force-save and never counts as a baseline shift (see `getBaseline`).
	| { kind: "review"; diskContent: string };

/** True for any external-change kind that must not be silently overwritten —
 * a real edit conflict or a pending review. Sweep this helper (rather than a
 * hardcoded `=== "conflict"` check) across every guard site that already
 * treats "conflict" as "don't blindly clobber," so "review" gets the same
 * protection. */
export function isUnresolvedExternalChange(kind: ExternalChange["kind"]) {
	return kind === "conflict" || kind === "review";
}

type DocumentState = {
	currentPath: string | null;
	lastOpenedPath: string | null;
	content: string;
	diskContent: string;
	externalChange: ExternalChange;
	status: ViewerStatus;
	error: string | null;
};

const NO_CONFLICT: ExternalChange = { kind: "none" };

export const MAX_RECENT = 10;
export const LOADING_DELAY_MS = 150;

export const emptyDoc = (
	lastOpenedPath: string | null = null,
): DocumentState => ({
	currentPath: null,
	lastOpenedPath,
	content: "",
	diskContent: "",
	externalChange: NO_CONFLICT,
	status: "idle",
	error: null,
});

export function cleanFileState(content: string) {
	return {
		content,
		diskContent: content,
		externalChange: NO_CONFLICT,
		status: "ready" as const,
		error: null,
	};
}

/**
 * Deliberately does NOT treat "review" like "conflict" here — the reference
 * point a second external edit is compared against must stay the true
 * pre-edit original while a review is pending. Shifting it to the pending
 * review's own disk snapshot would make a second external write (arriving
 * before the first review is resolved) misclassify as a true edit conflict
 * instead of correctly refreshing the pending review (see charter's
 * "Rejected" approach).
 */
export function getBaseline(state: DocumentState) {
	return state.externalChange.kind === "conflict"
		? state.externalChange.diskContent
		: state.diskContent;
}

export function applyFileAction(
	state: DocumentState,
	diskContent: string,
	action: FileAction,
	options?: { isVersionableMarkdownFile?: boolean },
): DocumentState {
	// R15: files doc-history doesn't track (non-Markdown files) must keep
	// today's exact silent-reload behavior — no review badge, no diff, no
	// timeline. Defaults to true so callers that never pass a path-derived
	// value (there are none left in this codebase, but this keeps the
	// function safe to call generically) keep the review behavior.
	const isVersionableMarkdownFile = options?.isVersionableMarkdownFile ?? true;
	switch (action) {
		case "none":
			// Disk content already matches the frozen baseline. Usually a genuine
			// no-op — but if a review was pending, this means a later external
			// write brought the file back to exactly the pre-review original, so
			// the pending review is moot and must not be left stale (R32).
			return state.externalChange.kind === "review"
				? { ...state, externalChange: NO_CONFLICT }
				: state;
		case "match":
			return {
				...state,
				...cleanFileState(diskContent),
			};
		case "reload":
			if (!isVersionableMarkdownFile) {
				// Non-Markdown (or otherwise not history-tracked) files never get
				// the review badge — silently swap in the new content exactly as
				// this app did before the review feature existed (R15).
				return {
					...state,
					...cleanFileState(diskContent),
				};
			}
			// Editor has no local edits, so this is a genuine external change. Show
			// a "review" badge instead of silently swapping content in — content
			// and diskContent (the frozen baseline) stay untouched so a SECOND
			// external edit arriving before this one is reviewed still compares
			// against the true original and refreshes the pending review (R11)
			// rather than misclassifying as a conflict. (`diskContent` can never
			// equal `state.diskContent` here — that exact case is already routed
			// to the "none" branch above, which handles R32's stale-revert case.)
			return {
				...state,
				status: "ready",
				error: null,
				externalChange: { kind: "review", diskContent },
			};
		case "conflict":
			return {
				...state,
				status: "ready",
				error: null,
				externalChange: {
					kind: "conflict",
					diskContent,
				},
			};
	}
}

export function isInWorkspace(
	path: string,
	workspacePath: string | null,
): boolean {
	if (!workspacePath) return false;
	if (path === workspacePath) return true;
	const normalizedWorkspace = workspacePath.endsWith("/")
		? workspacePath
		: `${workspacePath}/`;
	return path.startsWith(normalizedWorkspace);
}

export function withOpenedDoc(
	state: DesktopState,
	path: string,
	content: string,
): DesktopState {
	const workspacePath = state.workspace.workspacePath;
	const workspace =
		workspacePath && isInWorkspace(path, workspacePath)
			? {
					...state.workspace,
					lastOpenedPaths: {
						...state.workspace.lastOpenedPaths,
						[workspacePath]: path,
					},
				}
			: state.workspace;

	return {
		...state,
		workspace,
		document: {
			...state.document,
			currentPath: path,
			lastOpenedPath: path,
			...cleanFileState(content),
		},
	};
}

// ── Stores ──────────────────────────────────────────────────────────

export const appStore = store<DesktopState>(getInitialState(), {
	middleware: [localStoragePersist(STORAGE_KEY, serialize)],
});

export const workspaceStore = appStore.select("workspace");
export const viewerStore = appStore.select("document");
export const uiStore = appStore.select("ui");

// Diagnostic instrumentation for the background OOM crash: every write into the
// file-list store is the loop's "notify" edge, so counting them here (with the
// caller's stack on a storm) names the runtime trigger a heap snapshot cannot.
// See stormDetector.ts. The wrapper is a no-op unless the diagnostics bridge is
// present, and delegates to the original `set` (bound to preserve `this`).
const rawWorkspaceSet = workspaceStore.set.bind(workspaceStore);
workspaceStore.set = ((...args: Parameters<typeof rawWorkspaceSet>) => {
	recordStormEvent("workspaceStore.set");
	return rawWorkspaceSet(...args);
}) as typeof workspaceStore.set;

export const workspacePathStore = workspaceStore.select("workspacePath");
export const recentWorkspacesStore = workspaceStore.select("recentWorkspaces");
export const currentPathStore = viewerStore.select("currentPath");
export const sidebarOpenStore = uiStore.select("sidebarOpen");
export const switcherOpenStore = uiStore.select("isSwitcherOpen");
export const themePreferenceStore = uiStore.select("themePreference");
export const contrastPreferenceStore = uiStore.select("contrastPreference");
export const editorFontPreferenceStore = uiStore.select("editorFontPreference");
export const showIgnoredWorkspaceFilesStore = uiStore.select(
	"showIgnoredWorkspaceFiles",
);
export const sourceRetentionPreferenceStore = uiStore.select(
	"sourceRetentionPreference",
);
