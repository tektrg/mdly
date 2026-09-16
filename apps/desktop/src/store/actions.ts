import { toast } from "sonner";
import { desktopApi } from "../desktopApi";
import type { InAppHistoryCause } from "../desktopApi/types";
import { classifyFileChange } from "../externalFileChange";
import {
	absoluteWorkspacePath,
	basename,
	dirname,
	extname,
	hasMarkdownExtension,
	joinPath,
	markdownAssetFolderPath,
	normalizePath,
	pathEquals,
	pathInFolder,
	relativeWorkspacePath,
	replacePathPrefix,
} from "../lib/filePath";
import { latest } from "../lib/latest";
import {
	indexMovedFiles,
	type MovedFile,
	movedMarkdownFiles,
	pathAfterMove,
	rewriteMovedLinks,
} from "../lib/markdownLinkRewrite";
import type {
	ContrastPreference,
	EditorFontPreference,
	ThemePreference,
} from "../lib/theme";
import { closeDocumentToTable } from "./closeDocument";
import {
	clearDocNavigationHistory,
	getDocNavigationHistory,
	navigateBack,
	navigateForward,
	recordDocNavigation,
	removeDocNavigationPath,
	setDocNavigationHistory,
	TABLE_NAV_ENTRY,
	updateDocNavigationPath,
	updateDocNavigationPrefix,
} from "./docNavigationHistory";
import { flushEditorDraft } from "./editorDraft";
export { clearDocNavigationHistory };

import type { SourceRetentionPreference } from "./persistence";
import {
	applyFileAction,
	appStore,
	cleanFileState,
	contrastPreferenceStore,
	editorFontPreferenceStore,
	emptyDoc,
	type FileEntry,
	isInWorkspace,
	LOADING_DELAY_MS,
	MAX_RECENT,
	type SortMode,
	showIgnoredWorkspaceFilesStore,
	sidebarAutoCollapsedStore,
	sidebarOpenStore,
	sourceRetentionPreferenceStore,
	switcherOpenStore,
	themePreferenceStore,
	viewerStore,
	withOpenedDoc,
	workspaceStore,
} from "./state";
import { recordStormEvent } from "./stormDetector";

const REFRESH_FILES_DEBOUNCE_MS = 250;
const missingPathErrorPattern = /\bENOENT\b|\bENOTDIR\b/;
let refreshFilesTimer: ReturnType<typeof setTimeout> | null = null;

type SidebarMoveItem =
	| { kind: "file"; path: string }
	| { kind: "folder"; folderId: string };

export async function refreshFiles(path = workspaceStore.get().workspacePath) {
	if (!path) return;
	// Diagnostic: count file scans so a storm's stack names who kicks them off
	// (the store-write stack is post-`await`, so it cannot). See stormDetector.ts.
	recordStormEvent("refreshFiles");
	// R8: an empty listing and a failed listing are not the same thing. Capture
	// which one happened so the document table can say "couldn't read this
	// folder" instead of a confident "no documents" for a workspace that was
	// deleted, unmounted, or had its permission revoked.
	let listingError: string | null = null;
	const listing = await desktopApi
		.listDirectory(path, {
			includeIgnoredWorkspaceFiles: showIgnoredWorkspaceFilesStore.get(),
		})
		.catch((err: unknown): null => {
			listingError = errorMessage(err);
			notifyListingFailed(listingError);
			return null;
		});

	workspaceStore.set((state) => {
		if (state.workspacePath !== path) return state;
		// D3: one unreadable moment — a network volume blipping, a folder briefly
		// locked — must not replace rows that are already on screen with an empty
		// table. Keep the last good listing and let `listingError` be what changes.
		if (!listing) return { ...state, hasListedOnce: true, listingError };
		return {
			...state,
			files: listing.files,
			folders: listing.folders,
			hasListedOnce: true,
			listingError,
		};
	});
}

/**
 * Every failed listing is worth a word: the two refreshes that fire against a
 * table already on screen — the window-focus refresh and the menu's Sync — used
 * to fail in silence, because the toast was gated on an option only the
 * workspace-switch door passed.
 *
 * One fixed id, so a watcher storm against an unreachable volume replaces the
 * toast instead of stacking hundreds of them.
 */
function notifyListingFailed(message: string) {
	toast.error("Failed to load workspace files", {
		id: "workspace-listing-failed",
		description: message,
	});
}

/**
 * Debounced wrapper for event-driven sidebar refreshes.
 *
 * Keep `refreshFiles()` immediate for user actions that await a fresh snapshot.
 * Prefer debounced for refreshes triggered by effects.
 */
export function refreshFilesDebounced(
	path = workspaceStore.get().workspacePath,
) {
	if (!path) return;
	if (refreshFilesTimer !== null) clearTimeout(refreshFilesTimer);
	refreshFilesTimer = setTimeout(() => {
		refreshFilesTimer = null;
		void refreshFiles(path);
	}, REFRESH_FILES_DEBOUNCE_MS);
}

function errorMessage(err: unknown) {
	return err instanceof Error ? err.message : String(err);
}

function refreshFilesAfterMissingPath(message: string) {
	if (!missingPathErrorPattern.test(message)) return;
	// Missing files usually mean the sidebar snapshot is stale because Hubble no
	// longer watches the whole workspace.
	refreshFilesDebounced();
}

function handleFileError(err: unknown) {
	const message = errorMessage(err);
	refreshFilesAfterMissingPath(message);
	return message;
}

function pathStartsWithFolder(filePath: string, folderPath: string): boolean {
	return pathEquals(filePath, folderPath) || pathInFolder(filePath, folderPath);
}

function moveAffectsPath(path: string, sourcePath: string, isFolder: boolean) {
	return isFolder
		? pathStartsWithFolder(path, sourcePath)
		: pathEquals(path, sourcePath);
}

function setViewerCleanContent(path: string, content: string) {
	viewerStore.set((state) => {
		if (state.currentPath !== path) return state;
		return {
			...state,
			...cleanFileState(content),
		};
	});
}

async function writeFileIfChanged(path: string, current: string, next: string) {
	if (next === current) return false;
	await desktopApi.writeFileText(path, next);
	setViewerCleanContent(path, next);
	return true;
}

async function moveAssociatedAssetFolder(
	fromFilePath: string,
	toFilePath: string,
) {
	if (!hasMarkdownExtension(fromFilePath)) return null;
	const fromAssetFolder = markdownAssetFolderPath(fromFilePath);
	const toAssetFolder = markdownAssetFolderPath(toFilePath);
	if (
		!fromAssetFolder ||
		!toAssetFolder ||
		pathEquals(fromAssetFolder, toAssetFolder)
	) {
		return null;
	}
	// Asset folders are optional; check first so Electron does not log a
	// rejected rename for normal notes without assets.
	if (!(await desktopApi.pathExists(fromAssetFolder))) return null;
	try {
		await desktopApi.renameFile(fromAssetFolder, toAssetFolder);
		return { fromPath: fromAssetFolder, toPath: toAssetFolder };
	} catch (err) {
		if (missingPathErrorPattern.test(errorMessage(err))) return null;
		throw err;
	}
}

/**
 * Updates Markdown and wiki links after sidebar rename/move operations.
 *
 * Each file is processed once. Links are resolved from the file's old path, then
 * written relative to its new path so folder moves and file moves share one path.
 */
async function updateMovedLinks(movedFiles: MovedFile[], files: FileEntry[]) {
	const workspacePath = workspaceStore.get().workspacePath;
	if (!workspacePath || movedFiles.length === 0) return;
	const movedByOldPath = indexMovedFiles(movedFiles);
	flushEditorDraft();
	const current = viewerStore.get();

	for (const file of files.filter(
		(file) => hasMarkdownExtension(file.path) && !file.is_symlink,
	)) {
		const nextPath = pathAfterMove(file.path, movedByOldPath);
		try {
			// The open editor may have unsaved changes, so disk content is stale for
			// that file. Rewrite from the draft and then save that rewritten draft.
			const content = pathEquals(current.currentPath ?? "", nextPath)
				? current.content
				: await desktopApi.readFileText(nextPath);
			const nextContent = rewriteMovedLinks({
				content,
				filePath: file.path,
				nextPath,
				workspacePath,
				movedByOldPath,
			});
			await writeFileIfChanged(nextPath, content, nextContent);
		} catch (err) {
			const message = handleFileError(err);
			toast.error("Failed to update links", { description: message });
		}
	}
}

function folderPathsFromFiles(files: FileEntry[]) {
	const folders = new Set<string>();
	for (const file of files) {
		let parent = dirname(file.path);
		while (parent) {
			folders.add(parent.toLocaleLowerCase());
			const nextParent = dirname(parent);
			parent = nextParent === parent ? null : nextParent;
		}
	}
	return folders;
}

function uniqueMovePath(parent: string, sourcePath: string, isFolder: boolean) {
	const sourceName = basename(sourcePath);
	const extension = isFolder ? "" : extname(sourceName);
	const stem = extension ? sourceName.slice(0, -extension.length) : sourceName;
	const files = workspaceStore.get().files;
	const existing = new Set([
		...files.map((file) => file.path.toLocaleLowerCase()),
		...folderPathsFromFiles(files),
	]);
	for (let index = 0; ; index++) {
		const name = index === 0 ? sourceName : `${stem} ${index}${extension}`;
		const candidate = joinPath(parent, name);
		if (!existing.has(candidate.toLocaleLowerCase())) return candidate;
	}
}

function targetPathWithPreservedName(parent: string, sourcePath: string) {
	return normalizePath(joinPath(parent, basename(sourcePath)));
}

async function targetFileExists(path: string, files: FileEntry[]) {
	if (files.some((file) => pathEquals(file.path, path))) return true;
	return desktopApi.pathExists(path);
}

async function loadPinnedNotes(workspacePath: string) {
	const config = await desktopApi.readWorkspaceConfig(workspacePath);
	workspaceStore.set((state) => {
		if (state.workspacePath !== workspacePath) return state;
		return {
			...state,
			pinnedNotes: config.pinnedNotes.map((note) =>
				absoluteWorkspacePath(note, workspacePath),
			),
		};
	});
}

async function writePinnedNotes(workspacePath: string, pinnedNotes: string[]) {
	await desktopApi.writeWorkspaceConfig(workspacePath, {
		version: 1,
		pinnedNotes: pinnedNotes.map((note) =>
			relativeWorkspacePath(note, workspacePath),
		),
	});
}

async function syncPinnedNotes() {
	const workspacePath = workspaceStore.get().workspacePath;
	if (!workspacePath) return;
	try {
		await writePinnedNotes(workspacePath, workspaceStore.get().pinnedNotes);
	} catch (err) {
		const message = handleFileError(err);
		toast.error("Failed to update pinned notes", { description: message });
	}
}

export function touchFile(path: string) {
	workspaceStore.set((state) => {
		if (!isInWorkspace(path, state.workspacePath)) return state;
		return {
			...state,
			files: state.files.map((file) =>
				file.path === path
					? { ...file, modified_at: Math.floor(Date.now() / 1000) }
					: file,
			),
		};
	});
}

function uniqueMarkdownPath(parent: string): string {
	const files = workspaceStore.get().files;
	const existing = new Set(files.map((file) => file.path.toLocaleLowerCase()));
	for (let index = 1; ; index++) {
		const name = index === 1 ? "new-file.md" : `new-file-${index}.md`;
		const candidate = joinPath(parent, name);
		if (!existing.has(candidate.toLocaleLowerCase())) return candidate;
	}
}

const pendingRenames = new Map<string, string>();

export function getPendingRenameTarget(path: string) {
	return pendingRenames.get(path) ?? null;
}

export async function restorePersistedWorkspace() {
	const workspacePath = workspaceStore.get().workspacePath;
	if (!workspacePath) return;
	await Promise.all([
		refreshFiles(workspacePath),
		loadPinnedNotes(workspacePath),
	]);
}

export function setSortMode(mode: SortMode) {
	workspaceStore.select("sortMode").set(mode);
}

export function setWorkspaceSwitcherOpen(isOpen: boolean) {
	switcherOpenStore.set(isOpen);
}

/**
 * The single writer of the persisted sidebar preference. Any deliberate reveal
 * or hide also clears the runtime auto-collapse flag (R3), so a manual reopen
 * sticks until the *next* document open and a resize never re-collapses.
 */
export function setSidebarOpen(isOpen: boolean) {
	sidebarOpenStore.set(isOpen);
	sidebarAutoCollapsedStore.set(false);
}

/**
 * R3: hides the sidebar for a document on a narrow window without touching the
 * user's saved `sidebarOpen` preference — `sidebarAutoCollapsed` is runtime-only
 * (absent from `serialize()`), so nothing reaches localStorage.
 */
export function autoCollapseSidebarForDocument() {
	sidebarAutoCollapsedStore.set(true);
}

export function setThemePreference(themePreference: ThemePreference) {
	themePreferenceStore.set(themePreference);
}

export function setContrastPreference(contrastPreference: ContrastPreference) {
	contrastPreferenceStore.set(contrastPreference);
}

export function setEditorFontPreference(
	editorFontPreference: EditorFontPreference,
) {
	editorFontPreferenceStore.set(editorFontPreference);
}

export function setShowIgnoredWorkspaceFiles(
	showIgnoredWorkspaceFiles: boolean,
) {
	showIgnoredWorkspaceFilesStore.set(showIgnoredWorkspaceFiles);
	void refreshFiles();
}

export function setSourceRetentionPreference(
	sourceRetentionPreference: SourceRetentionPreference,
) {
	sourceRetentionPreferenceStore.set(sourceRetentionPreference);
}

/**
 * What the user actually sees. `sidebarOpen` is the saved preference;
 * `sidebarAutoCollapsed` is R3's runtime-only override. Every "is it showing?"
 * question — including the toggle's own reveal/hide decision — has to ask both,
 * or a Cmd+Shift+E on an auto-collapsed sidebar would take two presses to
 * reveal it.
 */
export function isSidebarVisible() {
	return sidebarOpenStore.get() && !sidebarAutoCollapsedStore.get();
}

export function toggleSidebar() {
	setSidebarOpen(!isSidebarVisible());
}

export function clearViewer() {
	viewerStore.set((state) => emptyDoc(state.lastOpenedPath));
}

/** Opens a workspace and reveals the sidebar. */
export async function openWorkspaceWithSidebar() {
	await openWorkspace();
	if (workspaceStore.get().workspacePath !== null) {
		setSidebarOpen(true);
	}
}

/** Creates a new folder, opens it as a workspace, and reveals the sidebar. */
export async function createWorkspaceWithSidebar() {
	const created = await desktopApi.createFolderPicker();
	if (typeof created !== "string") return;
	await openWorkspace(created);
	if (workspaceStore.get().workspacePath !== null) {
		setSidebarOpen(true);
	}
}

/** Opens a workspace by path. If no path given, shows a folder picker first. */
export async function openWorkspace(path?: string): Promise<boolean> {
	let nextPath = path;
	if (!nextPath) {
		const selected = await desktopApi.openFolderPicker();
		if (typeof selected !== "string") return false;
		nextPath = selected;
	}

	// R1: a workspace switch lands on the document table, never on that
	// workspace's last file (`lastOpenedPaths` bookkeeping is untouched). It
	// leaves through the ordinary close door, so it inherits that door's save of
	// unsaved edits and its cancel of an in-flight open — a bare `clearViewer()`
	// here did neither, losing the outgoing draft and letting a slow open land on
	// the new workspace's table. Before the workspace state moves, so the flush
	// runs while the file's own workspace is still current and the table appears
	// without waiting on the new listing. `recordNavigation: false` keeps a
	// switch out of the document back/forward stack, as before.
	await closeDocumentToTable({ recordNavigation: false });

	workspaceStore.set((state) => {
		const filtered = state.recentWorkspaces.filter((p) => p !== nextPath);
		return {
			...state,
			workspacePath: nextPath,
			recentWorkspaces: [nextPath, ...filtered].slice(0, MAX_RECENT),
			files: [],
			pinnedNotes: [],
			// R8: the new workspace has not been listed yet — an empty `files` here
			// means "scanning", not "no documents".
			hasListedOnce: false,
			listingError: null,
		};
	});
	switcherOpenStore.set(false);
	await Promise.all([refreshFiles(nextPath), loadPinnedNotes(nextPath)]);
	return true;
}

export function updateEditorContent(path: string, content: string) {
	const current = viewerStore.get();
	if (current.currentPath === path && current.content === content) return;

	viewerStore.set((state) => {
		if (state.currentPath !== path) return state;
		if (
			state.externalChange.kind === "applied" &&
			content === state.diskContent
		) {
			return { ...state, ...cleanFileState(content) };
		}
		return {
			...state,
			content,
			status: "ready",
			error: null,
		};
	});
}

export async function savePathContent(
	path: string,
	content: string,
	options?: { force?: boolean; historyCause?: InAppHistoryCause },
) {
	flushEditorDraft();
	const current = viewerStore.get();
	const force = options?.force === true;
	if (current.currentPath !== path) return;
	if (!force && current.content === content && content === current.diskContent)
		return;

	if (!force) {
		try {
			const currentDiskContent = await desktopApi.readFileText(path);
			const nextCurrent = viewerStore.get();
			if (nextCurrent.currentPath !== path) return;
			const action = classifyFileChange({
				editorContent: nextCurrent.content,
				baseline: nextCurrent.diskContent,
				diskContent: currentDiskContent,
			});
			if (action !== "none") {
				viewerStore.set((state) => {
					if (state.currentPath !== path) return state;
					return applyFileAction(state, currentDiskContent, action, {
						isVersionableMarkdownFile: hasMarkdownExtension(path),
					});
				});
				return;
			}
		} catch {
			// Fall through to the write path if the file cannot be read during preflight.
		}
	}

	try {
		// Ordinary saves keep the exact 2-argument call other tests/consumers
		// already assert on; only a tagged cut adds the options argument.
		if (options?.historyCause) {
			await desktopApi.writeFileText(path, content, {
				historyCause: options.historyCause,
			});
		} else {
			await desktopApi.writeFileText(path, content);
		}
		touchFile(path);
		viewerStore.set((state) => {
			if (state.currentPath !== path) return state;
			// Only write the saved text back into live editor content if the user
			// has not typed more while the save was in flight. Otherwise, just
			// move the saved baseline forward and keep the newer editor text.
			if (state.content === content) {
				return {
					...state,
					...cleanFileState(content),
				};
			}
			return {
				...state,
				diskContent: content,
				externalChange: { kind: "none" },
				status: "ready",
				error: null,
			};
		});
	} catch (err) {
		const message = handleFileError(err);
		toast.error("Failed to save file", { description: message });
		viewerStore.set((state) => {
			if (state.currentPath !== path) return state;
			return {
				...state,
				status: "error",
				error: message,
			};
		});
	}
}

export async function renameMarkdownFile(path: string, nextName: string) {
	flushEditorDraft();
	const current = viewerStore.get();
	const isCurrentFile = current.currentPath === path;
	const { files: filesBeforeRename, workspacePath } = workspaceStore.get();

	const trimmedName = nextName.trim();
	if (trimmedName.length === 0) return;

	const parent = dirname(path);
	if (!parent) return;

	const currentExt = extname(path);
	const nextNameWithExt = /\.[^/.\\]+$/.test(trimmedName)
		? trimmedName
		: `${trimmedName}${currentExt}`;
	// Slash paths are relative to the current file's folder, matching sidebar
	// rename behavior for nested notes.
	const nextPath = normalizePath(joinPath(parent, nextNameWithExt));
	if (!isSafeRelativeRenamePath(trimmedName, nextPath, workspacePath)) return;
	const symlinkFile = filesBeforeRename.find((file) => file.path === path);
	if (symlinkFile?.is_symlink && symlinkFile.symlink_target_exists !== false) {
		try {
			if (isCurrentFile) {
				await savePathContent(path, current.content, { force: true });
			}
			await desktopApi.renameSymlinkTarget(path, nextNameWithExt);
			await refreshFiles();
			if (isCurrentFile) {
				await loadPath(path);
			}
		} catch (err) {
			const message = handleFileError(err);
			toast.error("Failed to rename symlink target", {
				description: message,
			});
		}
		return;
	}
	if (nextPath === path) return;

	try {
		if (isCurrentFile) {
			await savePathContent(path, current.content, { force: true });
		}
		pendingRenames.set(path, nextPath);
		await desktopApi.renameFile(path, nextPath);
		const movedAssetFolder = await moveAssociatedAssetFolder(path, nextPath);
		const movedFiles = [{ fromPath: path, toPath: nextPath }];
		if (movedAssetFolder) movedFiles.push(movedAssetFolder);
		await updateMovedLinks(movedFiles, filesBeforeRename);
		appStore.set((state) => ({
			...state,
			workspace: {
				...state.workspace,
				files: state.workspace.files.map((file) =>
					file.path === path ? { ...file, path: nextPath } : file,
				),
				pinnedNotes: state.workspace.pinnedNotes.map((pinnedPath) =>
					pinnedPath === path ? nextPath : pinnedPath,
				),
				lastOpenedPaths: Object.fromEntries(
					Object.entries(state.workspace.lastOpenedPaths).map(
						([workspacePath, openedPath]) => [
							workspacePath,
							openedPath === path ? nextPath : openedPath,
						],
					),
				),
			},
			document: {
				...state.document,
				currentPath:
					state.document.currentPath === path
						? nextPath
						: state.document.currentPath,
				lastOpenedPath:
					state.document.lastOpenedPath === path
						? nextPath
						: state.document.lastOpenedPath,
			},
		}));
		updateDocNavigationPath(path, nextPath);
		await syncPinnedNotes();
		await refreshFiles();
		if (isCurrentFile) {
			await loadPath(nextPath, { historyAction: "replace" });
		}
	} catch (err) {
		pendingRenames.delete(path);
		const message = handleFileError(err);
		toast.error("Failed to rename file", { description: message });
	} finally {
		window.setTimeout(() => pendingRenames.delete(path), 1000);
	}
}

export async function renameCurrentMarkdownFile(nextName: string) {
	const current = viewerStore.get();
	if (!current.currentPath) return;
	await renameMarkdownFile(current.currentPath, nextName);
}

function isSafeRelativeRenamePath(
	name: string,
	nextPath: string,
	workspacePath: string | null,
) {
	if (!/[\\/]/.test(name)) return true;
	if (!workspacePath) return false;
	if (
		name.startsWith("/") ||
		name.startsWith("\\") ||
		/^[a-zA-Z]:[\\/]/.test(name)
	) {
		return false;
	}
	const normalized = normalizePath(name);
	if (
		normalized === "." ||
		normalized === ".." ||
		normalized.startsWith("../")
	) {
		return false;
	}
	return pathInFolder(nextPath, normalizePath(workspacePath));
}

export async function moveSidebarItem(
	item: SidebarMoveItem,
	targetFolderPath: string,
) {
	const workspacePath = workspaceStore.get().workspacePath;
	if (!workspacePath) return;
	const filesBeforeMove = workspaceStore.get().files;
	const sourcePath =
		item.kind === "file"
			? item.path
			: absoluteWorkspacePath(
					item.folderId.replace(/[\\/]+$/, ""),
					workspacePath,
				);
	const isFolder = item.kind === "folder";
	const sourceParent = dirname(sourcePath);
	if (!sourceParent) return;
	if (pathEquals(sourceParent, targetFolderPath)) return;
	if (isFolder && pathStartsWithFolder(targetFolderPath, sourcePath)) return;

	flushEditorDraft();
	const current = viewerStore.get();
	const currentPath = current.currentPath;
	const currentAffected =
		currentPath && moveAffectsPath(currentPath, sourcePath, isFolder);
	const nextPath = uniqueMovePath(targetFolderPath, sourcePath, isFolder);
	const sourceEntry = isFolder
		? workspaceStore
				.get()
				.folders.find((folder) => pathEquals(folder.path, sourcePath))
		: filesBeforeMove.find((file) => pathEquals(file.path, sourcePath));
	const movesSymlink = sourceEntry?.is_symlink === true;
	const movedFiles = movedMarkdownFiles(
		filesBeforeMove,
		sourcePath,
		nextPath,
		isFolder,
	).filter((movedFile) => {
		const file = filesBeforeMove.find((file) =>
			pathEquals(file.path, movedFile.fromPath),
		);
		return !file?.is_symlink;
	});

	try {
		if (currentAffected && currentPath) {
			await savePathContent(currentPath, current.content, { force: true });
		}
		await desktopApi.renameFile(sourcePath, nextPath);
		const movedAssetFolder =
			item.kind === "file" && !movesSymlink
				? await moveAssociatedAssetFolder(sourcePath, nextPath)
				: null;
		appStore.set((state) => ({
			...state,
			workspace: {
				...state.workspace,
				files: state.workspace.files.map((file) => ({
					...file,
					path: replacePathPrefix(file.path, sourcePath, nextPath),
				})),
				pinnedNotes: state.workspace.pinnedNotes.map((pinnedPath) =>
					replacePathPrefix(pinnedPath, sourcePath, nextPath),
				),
				lastOpenedPaths: Object.fromEntries(
					Object.entries(state.workspace.lastOpenedPaths).map(
						([workspace, openedPath]) => [
							workspace,
							replacePathPrefix(openedPath, sourcePath, nextPath),
						],
					),
				),
			},
			document: {
				...state.document,
				currentPath: state.document.currentPath
					? replacePathPrefix(state.document.currentPath, sourcePath, nextPath)
					: null,
				lastOpenedPath: state.document.lastOpenedPath
					? replacePathPrefix(
							state.document.lastOpenedPath,
							sourcePath,
							nextPath,
						)
					: null,
			},
		}));
		if (isFolder) {
			updateDocNavigationPrefix(sourcePath, nextPath);
		} else {
			updateDocNavigationPath(sourcePath, nextPath);
		}
		if (movedAssetFolder) movedFiles.push(movedAssetFolder);
		if (!movesSymlink) await updateMovedLinks(movedFiles, filesBeforeMove);
		await syncPinnedNotes();
		await refreshFiles();
	} catch (err) {
		const message = handleFileError(err);
		toast.error("Failed to move item", { description: message });
		await refreshFiles();
	}
}

export async function moveMarkdownFileToFolder(
	sourcePath: string,
	targetFolderPath: string,
	targetWorkspacePath = workspaceStore.get().workspacePath,
) {
	const sourceWorkspacePath = workspaceStore.get().workspacePath;
	if (!sourceWorkspacePath || !targetWorkspacePath) return false;
	if (!isInWorkspace(sourcePath, sourceWorkspacePath)) return false;

	const sourceParent = dirname(sourcePath);
	if (!sourceParent) return false;

	const nextPath = targetPathWithPreservedName(targetFolderPath, sourcePath);
	if (pathEquals(sourcePath, nextPath)) return true;

	const sameWorkspace = pathEquals(sourceWorkspacePath, targetWorkspacePath);
	const filesBeforeMove = workspaceStore.get().files;
	if (await targetFileExists(nextPath, sameWorkspace ? filesBeforeMove : [])) {
		toast.error("A file with that name already exists", {
			description: basename(sourcePath),
		});
		return false;
	}

	flushEditorDraft();
	const current = viewerStore.get();
	const isCurrentFile = pathEquals(current.currentPath ?? "", sourcePath);
	const movedFiles = sameWorkspace
		? movedMarkdownFiles(filesBeforeMove, sourcePath, nextPath, false)
		: [{ fromPath: sourcePath, toPath: nextPath }];

	try {
		if (isCurrentFile) {
			await savePathContent(sourcePath, current.content, { force: true });
		}
		pendingRenames.set(sourcePath, nextPath);
		await desktopApi.renameFile(sourcePath, nextPath);
		const movedAssetFolder = await moveAssociatedAssetFolder(
			sourcePath,
			nextPath,
		);
		if (sameWorkspace && movedAssetFolder) movedFiles.push(movedAssetFolder);

		appStore.set((state) => {
			const lastOpenedPaths = Object.fromEntries(
				Object.entries(state.workspace.lastOpenedPaths).filter(
					([workspace, openedPath]) =>
						!pathEquals(workspace, sourceWorkspacePath) ||
						!pathEquals(openedPath, sourcePath),
				),
			);
			if (sameWorkspace && isCurrentFile) {
				lastOpenedPaths[sourceWorkspacePath] = nextPath;
			}

			return {
				...state,
				workspace: {
					...state.workspace,
					files: sameWorkspace
						? state.workspace.files.map((file) =>
								pathEquals(file.path, sourcePath)
									? { ...file, path: nextPath }
									: file,
							)
						: state.workspace.files.filter(
								(file) => !pathEquals(file.path, sourcePath),
							),
					pinnedNotes: sameWorkspace
						? state.workspace.pinnedNotes.map((pinnedPath) =>
								pathEquals(pinnedPath, sourcePath) ? nextPath : pinnedPath,
							)
						: state.workspace.pinnedNotes.filter(
								(pinnedPath) => !pathEquals(pinnedPath, sourcePath),
							),
					lastOpenedPaths,
				},
				document:
					isCurrentFile && sameWorkspace
						? {
								...state.document,
								currentPath: nextPath,
								lastOpenedPath: nextPath,
							}
						: isCurrentFile
							? {
									...state.document,
									currentPath: nextPath,
									lastOpenedPath: nextPath,
								}
							: state.document,
			};
		});

		updateDocNavigationPath(sourcePath, nextPath);
		if (sameWorkspace) {
			await updateMovedLinks(movedFiles, filesBeforeMove);
		}
		await syncPinnedNotes();

		if (isCurrentFile && !sameWorkspace) {
			await openWorkspace(targetWorkspacePath);
			await loadPath(nextPath, { historyAction: "replace" });
			setSidebarOpen(true);
			return true;
		}

		await refreshFiles();
		if (isCurrentFile) {
			await loadPath(nextPath, { historyAction: "replace" });
		}
		return true;
	} catch (err) {
		const message = handleFileError(err);
		toast.error("Failed to move file", { description: message });
		await refreshFiles();
		return false;
	} finally {
		window.setTimeout(() => pendingRenames.delete(sourcePath), 1000);
	}
}

export async function createMarkdownFileInFolder(parentPath: string) {
	const path = uniqueMarkdownPath(parentPath);
	try {
		await desktopApi.writeFileText(path, "");
		const modified_at = Math.floor(Date.now() / 1000);
		workspaceStore.set((state) => ({
			...state,
			files: [...state.files, { path, modified_at }],
		}));
		await loadPath(path);
		await refreshFiles();
		return path;
	} catch (err) {
		const message = handleFileError(err);
		toast.error("Failed to create file", { description: message });
		return null;
	}
}

export async function deleteMarkdownFile(
	path: string,
	options?: { throwOnError?: boolean },
) {
	try {
		await desktopApi.deleteFile(path);
		appStore.set((state) => ({
			...state,
			workspace: {
				...state.workspace,
				files: state.workspace.files.filter((file) => file.path !== path),
				pinnedNotes: state.workspace.pinnedNotes.filter(
					(pinnedPath) => pinnedPath !== path,
				),
				lastOpenedPaths: Object.fromEntries(
					Object.entries(state.workspace.lastOpenedPaths).filter(
						([, openedPath]) => openedPath !== path,
					),
				),
			},
			document:
				state.document.currentPath === path
					? emptyDoc(
							state.document.lastOpenedPath === path
								? null
								: state.document.lastOpenedPath,
						)
					: {
							...state.document,
							lastOpenedPath:
								state.document.lastOpenedPath === path
									? null
									: state.document.lastOpenedPath,
						},
		}));
		removeDocNavigationPath(path);
		await syncPinnedNotes();
		await refreshFiles();
	} catch (err) {
		const message = handleFileError(err);
		toast.error("Failed to delete file", { description: message });
		if (options?.throwOnError) throw err;
	}
}

export async function deleteFolder(path: string) {
	try {
		await desktopApi.deleteFile(path, { recursive: true });
		appStore.set((state) => ({
			...state,
			workspace: {
				...state.workspace,
				files: state.workspace.files.filter(
					(file) => !pathInFolder(file.path, path),
				),
				pinnedNotes: state.workspace.pinnedNotes.filter(
					(pinnedPath) => !pathInFolder(pinnedPath, path),
				),
				lastOpenedPaths: Object.fromEntries(
					Object.entries(state.workspace.lastOpenedPaths).filter(
						([, openedPath]) => !pathInFolder(openedPath, path),
					),
				),
			},
			document:
				state.document.currentPath &&
				pathInFolder(state.document.currentPath, path)
					? emptyDoc(
							state.document.lastOpenedPath &&
								pathInFolder(state.document.lastOpenedPath, path)
								? null
								: state.document.lastOpenedPath,
						)
					: {
							...state.document,
							lastOpenedPath:
								state.document.lastOpenedPath &&
								pathInFolder(state.document.lastOpenedPath, path)
									? null
									: state.document.lastOpenedPath,
						},
		}));
		removeDocNavigationPath(path);
		await syncPinnedNotes();
		await refreshFiles();
	} catch (err) {
		const message = handleFileError(err);
		toast.error("Failed to delete folder", { description: message });
	}
}

export function handleExternalFileChange(
	path: string,
	nextDiskContent: string,
) {
	flushEditorDraft();
	viewerStore.set((state) => {
		if (state.currentPath !== path) return state;
		const action = classifyFileChange({
			editorContent: state.content,
			baseline: state.diskContent,
			diskContent: nextDiskContent,
		});
		return applyFileAction(state, nextDiskContent, action, {
			isVersionableMarkdownFile: hasMarkdownExtension(path),
		});
	});
}

/**
 * Undo is a deliberate user action, not a passive edit, so it saves right
 * away through the normal (non-forced) save path rather than waiting on the
 * keystroke autosave debounce or the next note switch — otherwise the
 * reverted content stays visibly stale on disk until one of those fires.
 */
export async function undoExternalChange() {
	const current = viewerStore.get();
	const path = current.currentPath;
	if (!path || current.externalChange.kind !== "applied") return;
	const previousContent = current.externalChange.previousContent;
	viewerStore.set((state) => {
		if (state.currentPath !== path || state.externalChange.kind !== "applied") {
			return state;
		}
		return {
			...state,
			content: previousContent,
			externalChange: { kind: "none" },
		};
	});
	await savePathContent(path, previousContent, { historyCause: "manual" });
}

export type LoadPathOptions = {
	historyAction?: "push" | "replace" | "skip";
};

/**
 * Persists unsaved edits of the outgoing document before the viewer moves on.
 *
 * The editor's unmount save fires after `currentPath` has already changed, so
 * `savePathContent`'s path guard would silently drop it. This is also the one
 * place a workspace switch's forced history cut (R17) can land: it runs before
 * `currentPath` moves, at the file's correct path, so tagging it with
 * `historyCause` records a revision for an edit that would otherwise never get
 * one on a file-to-file switch.
 *
 * `nextPath` is the document about to be opened, or `null` when the document is
 * being closed outright — a close must flush unconditionally.
 */
export async function flushOutgoingEdits(nextPath: string | null = null) {
	flushEditorDraft();
	const previous = viewerStore.get();
	if (
		previous.currentPath &&
		previous.currentPath !== nextPath &&
		previous.status === "ready" &&
		previous.content !== previous.diskContent
	) {
		await savePathContent(previous.currentPath, previous.content, {
			historyCause: "idle-session",
		});
	}
}

export const loadPath = latest(
	async ({ isStale }, path: string, options?: LoadPathOptions) => {
		// Claim the main panel for this document synchronously, before the first
		// `await`: the layout flips on the same frame as the click, with no
		// full-width-table flash and no LOADING_DELAY_MS gap. This is the only
		// write site of `requestedPath`, so all 17 open-doors inherit it.
		viewerStore.set((state) => ({ ...state, requestedPath: path }));
		await flushOutgoingEdits(path);

		const timer = window.setTimeout(() => {
			if (isStale()) return;
			viewerStore.set((state) => ({
				...state,
				status: "loading",
				error: null,
			}));
		}, LOADING_DELAY_MS);

		try {
			const content = await desktopApi.readFileText(path);
			if (isStale()) return;
			appStore.set((state) => withOpenedDoc(state, path, content));
			if (options?.historyAction !== "skip") {
				recordDocNavigation(path, {
					replace: options?.historyAction === "replace",
				});
			}
		} catch (err) {
			if (isStale()) return;
			const message = handleFileError(err);
			toast.error("Failed to open file", { description: message });
			viewerStore.set((state) => ({
				...emptyDoc(state.lastOpenedPath),
				// R5: loading and error are states of the document pane only. Keeping
				// `requestedPath` here is what stops a failed open from slamming the
				// user back to the full-width table — the list stays on screen and
				// another row can be clicked to recover.
				requestedPath: path,
				status: "error",
				error: message,
			}));
		} finally {
			window.clearTimeout(timer);
		}
	},
);

/**
 * Walks to a history entry. The table is a real stack entry (`TABLE_NAV_ENTRY`),
 * so a step onto it closes the document instead of trying to read it as a file.
 */
async function navigateToHistoryEntry(targetPath: string) {
	if (targetPath === TABLE_NAV_ENTRY) {
		await closeDocumentToTable({ recordNavigation: false });
		return;
	}
	await loadPath(targetPath, { historyAction: "skip" });
}

export async function goBackDocument(): Promise<boolean> {
	const history = getDocNavigationHistory();
	const result = navigateBack(history);
	if (!result) return false;
	setDocNavigationHistory(result.nextHistory);
	await navigateToHistoryEntry(result.targetPath);
	return true;
}

export async function goForwardDocument(): Promise<boolean> {
	const history = getDocNavigationHistory();
	const result = navigateForward(history);
	if (!result) return false;
	setDocNavigationHistory(result.nextHistory);
	await navigateToHistoryEntry(result.targetPath);
	return true;
}

export async function togglePinnedNote(path: string) {
	const workspacePath = workspaceStore.get().workspacePath;
	if (!workspacePath || !isInWorkspace(path, workspacePath)) return;
	const pinnedNotes = workspaceStore.get().pinnedNotes;
	const nextPinnedNotes = pinnedNotes.includes(path)
		? pinnedNotes.filter((pinnedPath) => pinnedPath !== path)
		: [...pinnedNotes, path];
	workspaceStore.set((state) => ({
		...state,
		pinnedNotes: nextPinnedNotes,
	}));
	try {
		await writePinnedNotes(workspacePath, nextPinnedNotes);
	} catch (err) {
		const message = handleFileError(err);
		toast.error("Failed to update pinned notes", { description: message });
		await loadPinnedNotes(workspacePath);
	}
}
