import { Button } from "@hubble.md/ui";
import { useShallow, useStoreValue } from "@simplestack/store/react";
import { keymatch } from "keymatch";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import MingcuteLayoutLeftLine from "~icons/mingcute/layout-left-line";
import MingcuteLoading3Line from "~icons/mingcute/loading-3-line";
import { AgentAccessSettings } from "./components/AgentAccessSettings";
import {
	HtmlAppsDialog,
	SidebarHtmlAppsCallout,
} from "./components/HtmlAppsCallout";
import { ImportDocDialog } from "./components/ImportDocDialog";
import { MainPanel } from "./components/MainPanel";
import { ReimportDocDialog } from "./components/ReimportDocDialog";
import {
	AppearanceSettings,
	CloudSyncSettings,
	ImportSettings,
	SettingsDialog,
	WorkspaceSettings,
} from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import {
	SidebarUpdateCallout,
	UpdatesSection,
} from "./components/UpdatesSection";
import { desktopApi } from "./desktopApi";
import type { DesktopUpdateState, HistoryRevision } from "./desktopApi/types";
import {
	applyDocReimport,
	createMarkdownFile,
	currentDocImportStatus,
	currentNotionLinkStatus,
	type DocReimportResolution,
	importNotionDatabase,
	openOrImportNotionPage,
	prepareDocReimport,
	pushCurrentNotionPage,
	refreshCurrentNotionPage,
} from "./fileActions";
import { basename, joinPath } from "./lib/filePath";
import { hasHubbleSkillsInstalled } from "./lib/hubbleSkills";
import {
	applyContrastPreference,
	applyEditorFontPreference,
	syncThemePreference,
} from "./lib/theme";
import { notionBrowserUrlForMarkdown } from "./notion/notionBrowserUrl";
import { parseNotionDatabaseMetadata } from "./notion/notionDatabase";
import { EDITABLE_FOCUS_SELECTOR, SIDEBAR_NAV_SELECTOR } from "./selectors";
import {
	autoCollapseSidebarForDocument,
	createWorkspaceWithSidebar,
	getPendingRenameTarget,
	goBackDocument,
	goForwardDocument,
	handleExternalFileChange,
	isSidebarVisible,
	loadPath,
	moveMarkdownFileToFolder,
	openWorkspace,
	openWorkspaceWithSidebar,
	refreshFiles,
	refreshFilesDebounced,
	restorePersistedWorkspace,
	setSidebarOpen,
	setWorkspaceSwitcherOpen,
} from "./store/actions";
import {
	closeDocumentToTable,
	registerDocumentPanelReset,
} from "./store/closeDocument";
import {
	contrastPreferenceStore,
	editorFontPreferenceStore,
	requestedPathStore,
	sidebarAutoCollapsedStore,
	sidebarOpenStore,
	switcherOpenStore,
	themePreferenceStore,
	viewerStore,
	workspacePathStore,
	workspaceStore,
} from "./store/state";

// Heavy, on-demand panels are code-split and mounted only after first open, so
// their chunks stay out of the startup bundle.
const CommandBar = lazy(() =>
	import("./components/CommandBar").then((module) => ({
		default: module.CommandBar,
	})),
);
const NotionOpenDialog = lazy(() =>
	import("./components/NotionOpenDialog").then((module) => ({
		default: module.NotionOpenDialog,
	})),
);

const HTML_APPS_CALLOUT_DISMISSED_PREFIX =
	"hubble:html-apps-callout-dismissed:";

function isHtmlAppsCalloutDismissed(workspacePath: string) {
	return Boolean(
		localStorage.getItem(HTML_APPS_CALLOUT_DISMISSED_PREFIX + workspacePath),
	);
}

function focusSidebarNav() {
	document.querySelector<HTMLElement>(SIDEBAR_NAV_SELECTOR)?.focus();
}

async function copyFilePath(path: string | null) {
	if (!path) return;

	try {
		await navigator.clipboard.writeText(path);
		toast.success("File path copied");
	} catch {
		toast.error("Failed to copy file path");
	}
}

async function revealPath(path: string | null) {
	if (!path) return;

	try {
		await desktopApi.revealFile(path);
	} catch {
		toast.error("Failed to reveal file");
	}
}

function alertNotionRefreshBlockedByLocalChanges(options?: {
	onForceRefresh?: () => void;
}) {
	toast.error("Notion refresh paused", {
		description:
			"This file has local changes since the last Notion fetch. Push them to Notion, or refresh anyway to replace local changes with the latest Notion version.",
		action: options?.onForceRefresh
			? {
					label: "Refresh",
					onClick: options.onForceRefresh,
				}
			: undefined,
	});
}

function WindowDragRegion() {
	return <div className="desktop-window-drag-strip" aria-hidden="true" />;
}

function App() {
	// Subscribe to only the viewer fields App renders with. Live editor `content`
	// is deliberately excluded so per-keystroke content updates don't re-render
	// App (and with it Sidebar/Toolbar/CommandBar). The content-dependent view is
	// isolated in <ReadyDocument>, which subscribes to content itself.
	const state = useStoreValue(
		viewerStore,
		useShallow((viewer) => ({
			status: viewer.status,
			currentPath: viewer.currentPath,
			error: viewer.error,
		})),
	);
	const isNotionDatabase = useStoreValue(viewerStore, (viewer) =>
		viewer.status === "ready"
			? parseNotionDatabaseMetadata(viewer.content) !== null
			: false,
	);
	const workspace = useStoreValue(workspaceStore);
	const workspacePath = useStoreValue(workspacePathStore);
	const sidebarOpen = useStoreValue(sidebarOpenStore);
	const sidebarAutoCollapsed = useStoreValue(sidebarAutoCollapsedStore);
	// The saved preference minus R3's runtime auto-collapse. `sidebarOpen`
	// itself is never written by auto-collapse, so the user's preference
	// survives a narrow-window document session untouched.
	const sidebarVisible = sidebarOpen && !sidebarAutoCollapsed;
	const requestedPath = useStoreValue(requestedPathStore);
	const themePreference = useStoreValue(themePreferenceStore);
	const contrastPreference = useStoreValue(contrastPreferenceStore);
	const editorFontPreference = useStoreValue(editorFontPreferenceStore);
	const hasWorkspace = workspacePath !== null;
	const [scrollContainerEl, setScrollContainerEl] =
		useState<HTMLDivElement | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const isSwitcherOpen = useStoreValue(switcherOpenStore);
	const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(
		null,
	);
	const [focusedSidebarPath, setFocusedSidebarPath] = useState<string | null>(
		null,
	);
	const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
	const [htmlAppsDialogOpen, setHtmlAppsDialogOpen] = useState(false);
	const [htmlAppsCalloutVisible, setHtmlAppsCalloutVisible] = useState(false);
	const [notionDialogOpen, setNotionDialogOpen] = useState(false);
	const [commandBarOpen, setCommandBarOpen] = useState(false);
	const [reimportOpen, setReimportOpen] = useState(false);
	const [importDocOpen, setImportDocOpen] = useState(false);
	const isAnyDialogOpen =
		commandBarOpen ||
		settingsOpen ||
		htmlAppsDialogOpen ||
		notionDialogOpen ||
		reimportOpen ||
		importDocOpen ||
		isSwitcherOpen;
	const [historyOpen, setHistoryOpen] = useState(false);
	// Only one right-edge panel open at a time (R21): opening comments closes
	// history and vice versa. Closing a panel never touches the other.
	const [commentsOpen, setCommentsOpen] = useState(false);
	const handleCommentsOpenChange = useCallback((open: boolean) => {
		setCommentsOpen(open);
		if (open) setHistoryOpen(false);
	}, []);
	// The revision currently swapped into the main document pane as a diff
	// (see `ReadyDocument`), or null when the live editor is showing.
	const [viewingRevision, setViewingRevision] =
		useState<HistoryRevision | null>(null);
	const [reimportFresh, setReimportFresh] = useState<{
		markdown: string;
		contentHash: string;
	} | null>(null);
	const [reimportError, setReimportError] = useState<string | null>(null);
	// Keep code-split panels mounted once opened so close animations still play.
	const [commandBarMounted, setCommandBarMounted] = useState(false);
	const [notionDialogMounted, setNotionDialogMounted] = useState(false);
	useEffect(() => {
		if (commandBarOpen) setCommandBarMounted(true);
	}, [commandBarOpen]);
	useEffect(() => {
		if (notionDialogOpen) setNotionDialogMounted(true);
	}, [notionDialogOpen]);
	const [commandBarMoveSourcePath, setCommandBarMoveSourcePath] = useState<
		string | null
	>(null);
	const [notionLoadingLabel, setNotionLoadingLabel] = useState<string | null>(
		null,
	);
	const [notionDatabaseRefreshToken, setNotionDatabaseRefreshToken] =
		useState(0);
	const notionOpenRefreshPathRef = useRef<string | null>(null);
	const skipNextNotionOpenRefreshPathRef = useRef<string | null>(null);

	const dismissHtmlAppsCallout = useCallback(() => {
		if (workspacePath) {
			localStorage.setItem(
				HTML_APPS_CALLOUT_DISMISSED_PREFIX + workspacePath,
				"1",
			);
		}
		setHtmlAppsCalloutVisible(false);
	}, [workspacePath]);

	// Show the HTML Apps callout when a folder is open, the Hubble skills are
	// not installed there, and it has not been dismissed for that folder.
	useEffect(() => {
		if (!workspacePath || isHtmlAppsCalloutDismissed(workspacePath)) {
			setHtmlAppsCalloutVisible(false);
			return;
		}
		let active = true;
		void hasHubbleSkillsInstalled(workspacePath).then((installed) => {
			if (active) setHtmlAppsCalloutVisible(!installed);
		});
		return () => {
			active = false;
		};
	}, [workspacePath]);
	const readyVersion =
		updateState?.status === "ready"
			? (updateState.availableVersion ?? "__unknown__")
			: null;
	const showUpdateCallout = readyVersion !== dismissedVersion;
	const notionLink = currentNotionLinkStatus();
	const notionSyncMode = notionLink
		? "page"
		: isNotionDatabase
			? "database"
			: "none";
	const docImported = currentDocImportStatus() !== null;

	useEffect(() => {
		return syncThemePreference(themePreference);
	}, [themePreference]);

	useEffect(() => {
		applyContrastPreference(contrastPreference);
	}, [contrastPreference]);

	useEffect(() => {
		applyEditorFontPreference(editorFontPreference);
	}, [editorFontPreference]);

	const openSettings = useCallback(() => {
		setSettingsOpen(true);
	}, []);

	const pushNotionPage = useCallback(async () => {
		try {
			const result = await pushCurrentNotionPage();
			if (result.kind === "remote-changed") {
				const overwrite = window.confirm(
					"Notion changed since the last sync. Overwrite the Notion page with this local file?",
				);
				if (!overwrite) return;
				const forced = await pushCurrentNotionPage({
					forceRemoteOverwrite: true,
				});
				if (forced.kind !== "pushed") return;
			} else if (result.kind !== "pushed") {
				return;
			}
			toast.success("Pushed to Notion");
		} catch (error) {
			toast.error("Failed to push to Notion", {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	}, []);

	const forceRefreshNotionPage = useCallback(async () => {
		try {
			const result = await refreshCurrentNotionPage({
				forceLocalOverwrite: true,
			});
			if (result.kind === "refreshed") toast.success("Refreshed from Notion");
		} catch (error) {
			toast.error("Failed to refresh from Notion", {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	}, []);

	const refreshNotionPage = useCallback(async () => {
		if (parseNotionDatabaseMetadata(viewerStore.get().content)) {
			setNotionDatabaseRefreshToken((token) => token + 1);
			return;
		}

		try {
			const result = await refreshCurrentNotionPage();
			if (result.kind === "local-changes") {
				alertNotionRefreshBlockedByLocalChanges({
					onForceRefresh: () => void forceRefreshNotionPage(),
				});
				return;
			}
			if (result.kind === "refreshed") toast.success("Refreshed from Notion");
		} catch (error) {
			toast.error("Failed to refresh from Notion", {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	}, [forceRefreshNotionPage]);

	const reimportDoc = useCallback(async () => {
		const path = state.currentPath;
		if (!path) return;
		const prepared = await prepareDocReimport(path);
		if (prepared.kind === "not-imported") {
			toast.error("This file has no import source");
			return;
		}
		if (prepared.kind === "error") {
			toast.error("Re-import failed", { description: prepared.message });
			return;
		}
		setReimportFresh({
			markdown: prepared.markdown,
			contentHash: prepared.contentHash,
		});
		setReimportError(null);
		setReimportOpen(true);
	}, [state.currentPath]);

	const resolveReimport = useCallback(
		async (resolution: DocReimportResolution) => {
			const path = state.currentPath;
			setReimportOpen(false);
			if (!path || !reimportFresh) return;
			try {
				await applyDocReimport(path, resolution, reimportFresh);
				if (resolution !== "keep-local") {
					toast.success(
						resolution === "replace"
							? "Re-imported from source"
							: "Saved re-import as a new file",
					);
				}
			} catch (error) {
				toast.error("Re-import failed", {
					description: error instanceof Error ? error.message : String(error),
				});
			}
		},
		[state.currentPath, reimportFresh],
	);

	const openNotionInBrowser = useCallback(async () => {
		const url = notionBrowserUrlForMarkdown(viewerStore.get().content);
		if (!url) {
			toast.error("No Notion browser URL saved for this file");
			return;
		}

		try {
			await desktopApi.openExternalUrl(url);
		} catch (error) {
			toast.error("Failed to open Notion in browser", {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	}, []);

	useEffect(() => {
		const path = state.currentPath;
		if (!path) {
			notionOpenRefreshPathRef.current = null;
			return;
		}
		if (state.status !== "ready") return;
		if (notionOpenRefreshPathRef.current === path) return;
		notionOpenRefreshPathRef.current = path;
		if (skipNextNotionOpenRefreshPathRef.current === path) {
			skipNextNotionOpenRefreshPathRef.current = null;
			return;
		}

		if (!currentNotionLinkStatus()) return;
		let disposed = false;
		const refreshFromOpen = async () => {
			try {
				const result = await refreshCurrentNotionPage();
				if (result.kind === "local-changes") {
					if (!disposed) alertNotionRefreshBlockedByLocalChanges();
					return;
				}
			} catch (error) {
				if (disposed) return;
				toast.error("Failed to refresh from Notion", {
					description: error instanceof Error ? error.message : String(error),
				});
			}
		};
		void refreshFromOpen();
		return () => {
			disposed = true;
		};
	}, [state.currentPath, state.status]);

	const installUpdate = useCallback(async () => {
		try {
			await desktopApi.installUpdate();
		} catch (error) {
			toast.error("Failed to install update", {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	}, []);

	const triggerPrimaryUpdateAction = useCallback(async () => {
		if (!updateState?.isSupported) return;
		if (updateState.status === "ready") {
			await installUpdate();
			return;
		}
		await desktopApi.checkForUpdates();
	}, [installUpdate, updateState]);

	// Stable element identity so <Sidebar> (React.memo) can skip re-rendering
	// on every keystroke, which otherwise re-runs its O(workspace) file list mapping.
	const sidebarFooter = useMemo(() => {
		if (updateState?.status === "ready" && showUpdateCallout) {
			return (
				<SidebarUpdateCallout
					onInstall={installUpdate}
					onDismiss={() => setDismissedVersion(readyVersion ?? "__unknown__")}
				/>
			);
		}
		if (htmlAppsCalloutVisible) {
			return (
				<SidebarHtmlAppsCallout
					onShowMore={() => setHtmlAppsDialogOpen(true)}
					onDismiss={dismissHtmlAppsCallout}
				/>
			);
		}
		return undefined;
	}, [
		updateState,
		showUpdateCallout,
		installUpdate,
		readyVersion,
		htmlAppsCalloutVisible,
		dismissHtmlAppsCallout,
	]);

	useEffect(() => {
		const currentPath = state.currentPath;
		if (!currentPath) return;

		let disposed = false;
		let unwatch: null | (() => void) = null;

		const handleChange = async (paths: string[]) => {
			if (!paths.includes(currentPath)) return;
			if (getPendingRenameTarget(currentPath)) return;
			try {
				const nextContent = await desktopApi.readFileText(currentPath);
				if (viewerStore.get().currentPath !== currentPath) return;
				handleExternalFileChange(currentPath, nextContent);
			} catch {
				if (viewerStore.get().currentPath !== currentPath) return;
				await loadPath(currentPath);
			}
		};

		const setup = async () => {
			unwatch = await desktopApi.watchPath(
				currentPath,
				{ recursive: false },
				(paths) => void handleChange(paths),
			);
			if (disposed && unwatch) {
				unwatch();
			}
		};

		void setup();
		return () => {
			disposed = true;
			if (unwatch) {
				unwatch();
			}
		};
	}, [state.currentPath]);

	const openFilePicker = useCallback(async () => {
		const defaultPath =
			viewerStore.get().currentPath ??
			workspaceStore.get().workspacePath ??
			undefined;
		const selected = await desktopApi.openFilePicker({ defaultPath });
		if (typeof selected === "string") {
			await loadPath(selected);
		}
	}, []);

	const openCommandBarFile = useCallback((path: string) => {
		setSidebarOpen(true);
		void loadPath(path);
	}, []);

	const openCommandBarWorkspace = useCallback(async (path?: string) => {
		const switched = await openWorkspace(path);
		if (switched && workspaceStore.get().workspacePath !== null) {
			setSidebarOpen(true);
		}
		return switched;
	}, []);

	const openMoveFileCommandBar = useCallback((path: string | null) => {
		if (!path) return;
		setCommandBarMoveSourcePath(path);
		setCommandBarOpen(true);
	}, []);

	const handleCommandBarOpenChange = useCallback((nextOpen: boolean) => {
		setCommandBarOpen(nextOpen);
		if (!nextOpen) setCommandBarMoveSourcePath(null);
	}, []);

	const openMoveCurrentFileCommandBar = useCallback(() => {
		openMoveFileCommandBar(viewerStore.get().currentPath);
	}, [openMoveFileCommandBar]);

	const openNotionResult = useCallback(
		async (result: Parameters<typeof openOrImportNotionPage>[0]) => {
			const isPage = result.object === "page";
			setNotionLoadingLabel(
				isPage ? "Opening Notion page" : "Importing Notion table",
			);
			try {
				if (isPage) {
					await openOrImportNotionPage(result, {
						folderPath: focusedSidebarPath,
					});
					toast.success("Notion page opened");
					return;
				}
				await importNotionDatabase(result, {
					folderPath: focusedSidebarPath,
				});
				toast.success("Notion table imported");
			} finally {
				setNotionLoadingLabel(null);
			}
		},
		[focusedSidebarPath],
	);

	const moveFileToFolderWithoutNotionRefresh = useCallback(
		async (
			sourcePath: string,
			targetFolderPath: string,
			targetWorkspacePath: string,
		) => {
			const isCurrentFile = viewerStore.get().currentPath === sourcePath;
			const targetPath = joinPath(targetFolderPath, basename(sourcePath));
			if (isCurrentFile) {
				skipNextNotionOpenRefreshPathRef.current = targetPath;
			}
			const moved = await moveMarkdownFileToFolder(
				sourcePath,
				targetFolderPath,
				targetWorkspacePath,
			);
			if (!moved || !isCurrentFile)
				skipNextNotionOpenRefreshPathRef.current = null;
			return moved;
		},
		[],
	);

	useEffect(() => {
		void desktopApi.setMenuState({ hasWorkspace });
	}, [hasWorkspace]);

	useEffect(() => {
		if (!sidebarVisible) setFocusedSidebarPath(null);
	}, [sidebarVisible]);

	// Slice 0's `closeDocumentToTable()` resets the document-scoped panels
	// through this seam: they are App state, but `ReadyDocument`'s own reset
	// effect cannot run on a close because closing unmounts it.
	useEffect(
		() =>
			registerDocumentPanelReset(() => {
				setHistoryOpen(false);
				setCommentsOpen(false);
				setViewingRevision(null);
			}),
		[],
	);

	// R3: collapse the sidebar when a document takes the stage on a narrow
	// window. Deliberately keyed to the null -> non-null transition of
	// `requestedPath` and nothing else, so it can never fire on a resize, on a
	// re-render, or on a document-to-document switch.
	const previousRequestedPathRef = useRef<string | null>(requestedPath);
	useEffect(() => {
		const previousRequestedPath = previousRequestedPathRef.current;
		previousRequestedPathRef.current = requestedPath;
		if (previousRequestedPath !== null || requestedPath === null) return;
		if (!window.matchMedia("(max-width: 1199px)").matches) return;
		autoCollapseSidebarForDocument();
	}, [requestedPath]);

	useEffect(() => {
		const onKeyDown = async (event: KeyboardEvent) => {
			if (keymatch(event, "CmdOrCtrl+N")) {
				event.preventDefault();
				await createMarkdownFile();
			} else if (keymatch(event, "CmdOrCtrl+,")) {
				event.preventDefault();
				openSettings();
			} else if (keymatch(event, "CmdOrCtrl+Shift+O")) {
				if (!workspaceStore.get().workspacePath) return;
				event.preventDefault();
				setWorkspaceSwitcherOpen(true);
			} else if (keymatch(event, "CmdOrCtrl+Shift+A")) {
				event.preventDefault();
				await openWorkspaceWithSidebar();
			} else if (keymatch(event, "CmdOrCtrl+Shift+N")) {
				event.preventDefault();
				await desktopApi.openNewWindow();
			} else if (keymatch(event, "CmdOrCtrl+O")) {
				event.preventDefault();
				await openFilePicker();
			} else if (keymatch(event, "CmdOrCtrl+P")) {
				event.preventDefault();
				if (!workspaceStore.get().workspacePath) return;
				setCommandBarOpen(true);
				setCommandBarMoveSourcePath(null);
			} else if (keymatch(event, "CmdOrCtrl+Shift+C")) {
				const path = focusedSidebarPath ?? viewerStore.get().currentPath;
				if (!path) return;
				event.preventDefault();
				await copyFilePath(path);
			} else if (keymatch(event, "CmdOrCtrl+Alt+R")) {
				const path = focusedSidebarPath ?? viewerStore.get().currentPath;
				if (!path) return;
				event.preventDefault();
				await revealPath(path);
			} else if (keymatch(event, "CmdOrCtrl+Shift+E")) {
				event.preventDefault();
				const opening = !isSidebarVisible();
				setSidebarOpen(opening);
				if (opening) {
					requestAnimationFrame(() => focusSidebarNav());
				}
			} else if (keymatch(event, "CmdOrCtrl+[")) {
				if (isAnyDialogOpen) return;
				event.preventDefault();
				await goBackDocument();
			} else if (keymatch(event, "CmdOrCtrl+]")) {
				if (isAnyDialogOpen) return;
				event.preventDefault();
				await goForwardDocument();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [focusedSidebarPath, isAnyDialogOpen, openFilePicker, openSettings]);

	// R7: Escape is a **last resort**, not an owner. Every other component that
	// answers Escape leaves `defaultPrevented === true` (comments now included:
	// the comment panel's compose/view UI lives in workspace-kit's ThreadPanel,
	// a dialog whose own Escape handling is already covered by `commentsOpen`
	// below). The listener is bubble-phase on `window`, so every React handler
	// has already had its say by the time this runs.
	useEffect(() => {
		const onEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			if (isAnyDialogOpen || historyOpen || commentsOpen || viewingRevision) {
				return;
			}
			if (viewerStore.get().requestedPath === null) return;
			const focused = document.activeElement;
			if (
				focused instanceof HTMLElement &&
				focused.closest(EDITABLE_FOCUS_SELECTOR)
			) {
				return;
			}
			void closeDocumentToTable();
		};
		window.addEventListener("keydown", onEscape);
		return () => window.removeEventListener("keydown", onEscape);
	}, [commentsOpen, historyOpen, isAnyDialogOpen, viewingRevision]);

	useEffect(() => {
		let active = true;
		void desktopApi.getUpdateState().then((nextState) => {
			if (active) setUpdateState(nextState);
		});
		const unsubscribe = desktopApi.onUpdateStateChange((nextState) => {
			setUpdateState(nextState);
		});
		return () => {
			active = false;
			unsubscribe();
		};
	}, []);

	useEffect(() => {
		const unlisten = desktopApi.onOpenFile((path) => {
			void loadPath(path);
		});
		return () => {
			unlisten();
		};
	}, []);

	useEffect(() => {
		const disposers = [
			desktopApi.onMenuCreateMarkdownFile(() => void createMarkdownFile()),
			desktopApi.onMenuOpenFile(() => void openFilePicker()),
			desktopApi.onMenuOpenFolder(() => void openWorkspaceWithSidebar()),
			desktopApi.onMenuOpenSettings(() => openSettings()),
			desktopApi.onMenuShowWorkspaceSwitcher(() =>
				setWorkspaceSwitcherOpen(true),
			),
			desktopApi.onMenuSyncWorkspace(() => void refreshFiles()),
			desktopApi.onMenuImportDocument(() => setImportDocOpen(true)),
			desktopApi.onMenuGoBack(() => void goBackDocument()),
			desktopApi.onMenuGoForward(() => void goForwardDocument()),
		];
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, [openFilePicker, openSettings]);

	useEffect(() => {
		// Window focus can fire in bursts when switching apps, so debounce the
		// sidebar refresh and keep the editor interactive while it runs.
		const dispose = desktopApi.onWindowFocus(() => refreshFilesDebounced());
		return () => {
			dispose();
		};
	}, []);

	useEffect(() => {
		let active = true;
		const init = async () => {
			const launchPath = await desktopApi.getLaunchFilePath();
			if (!active) return;

			if (typeof launchPath === "string" && launchPath.length > 0) {
				await loadPath(launchPath);
				return;
			}
			const launchWorkspacePath = await desktopApi.getLaunchWorkspacePath();
			if (!active) return;

			if (
				typeof launchWorkspacePath === "string" &&
				launchWorkspacePath.length > 0
			) {
				await openWorkspace(launchWorkspacePath);
				setSidebarOpen(true);
				return;
			}
			// R1: no auto-reopen of the last document. The remembered document is
			// still tracked (`lastOpenedPaths`) and is simply the top row of the
			// document table under the default Modified-desc sort. The Finder
			// carve-out is the `getLaunchFilePath` branch above, deliberately
			// untouched.
			await restorePersistedWorkspace();
		};
		void init();
		return () => {
			active = false;
		};
	}, []);

	return (
		<main className="flex h-dvh flex-col bg-background text-foreground">
			<WindowDragRegion />
			<Toolbar
				scrollContainer={scrollContainerEl}
				onOpenNotionPage={() => setNotionDialogOpen(true)}
				onOpenNotionInBrowser={openNotionInBrowser}
				onPushNotionPage={pushNotionPage}
				onRefreshNotionPage={refreshNotionPage}
				onMoveCurrentFile={openMoveCurrentFileCommandBar}
				onReimportDoc={() => void reimportDoc()}
				onOpenRevisionHistory={() => {
					setCommentsOpen(false);
					setHistoryOpen(true);
				}}
				onOpenComments={() => {
					setHistoryOpen(false);
					setCommentsOpen(true);
				}}
				notionSyncMode={notionSyncMode}
				docImported={docImported}
			/>
			{!sidebarVisible && hasWorkspace && (
				<div
					className="desktop-window-no-drag pointer-events-none fixed top-3 z-30"
					style={{
						insetInlineStart:
							desktopApi.platform === "darwin"
								? "var(--hubble-traffic-light-inset, 70px)"
								: "0.75rem",
					}}
				>
					<div className="pointer-events-auto flex items-center overflow-hidden rounded-full border border-border/50 bg-background/78 shadow-[0_2px_8px_rgb(15_23_42/0.045)] backdrop-blur-md">
						<Button
							variant="ghost"
							size="icon-sm"
							className="rounded-none text-muted-foreground hover:bg-accent hover:text-foreground"
							aria-label="Show sidebar"
							title="Show sidebar (⌘⇧E)"
							onClick={() => {
								setSidebarOpen(true);
								requestAnimationFrame(() => focusSidebarNav());
							}}
						>
							<MingcuteLayoutLeftLine className="size-4" />
						</Button>
					</div>
				</div>
			)}
			<div className="flex min-h-0 flex-1 overflow-hidden">
				<Sidebar
					onFocusedPathChange={setFocusedSidebarPath}
					onMoveFile={openMoveFileCommandBar}
					footer={sidebarFooter}
				/>
				<section className="flex min-h-0 flex-1 flex-col overflow-hidden">
					<MainPanel
						hasWorkspace={hasWorkspace}
						onCreateFolder={() => void createWorkspaceWithSidebar()}
						onOpenFolder={() => void openWorkspaceWithSidebar()}
						notionDatabaseRefreshToken={notionDatabaseRefreshToken}
						onScrollContainerChange={setScrollContainerEl}
						historyOpen={historyOpen}
						onHistoryOpenChange={setHistoryOpen}
						commentsOpen={commentsOpen}
						onCommentsOpenChange={handleCommentsOpenChange}
						viewingRevision={viewingRevision}
						onViewingRevisionChange={setViewingRevision}
					/>
				</section>
			</div>
			<SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen}>
				<AppearanceSettings />
				<WorkspaceSettings />
				<ImportSettings />
				<CloudSyncSettings workspacePath={workspacePath ?? null} />
				<AgentAccessSettings />
				{updateState ? (
					<UpdatesSection
						state={updateState}
						onPrimaryAction={() => void triggerPrimaryUpdateAction()}
					/>
				) : null}
			</SettingsDialog>
			<HtmlAppsDialog
				open={htmlAppsDialogOpen}
				onOpenChange={setHtmlAppsDialogOpen}
				workspacePath={workspacePath ?? null}
			/>
			{notionDialogMounted ? (
				<Suspense fallback={null}>
					<NotionOpenDialog
						open={notionDialogOpen}
						onOpenChange={setNotionDialogOpen}
						onImportDatabase={openNotionResult}
						onImportPage={openNotionResult}
					/>
				</Suspense>
			) : null}
			<ImportDocDialog open={importDocOpen} onOpenChange={setImportDocOpen} />
			<ReimportDocDialog
				open={reimportOpen}
				onOpenChange={setReimportOpen}
				onResolve={(resolution) => void resolveReimport(resolution)}
				error={reimportError}
			/>
			{commandBarMounted ? (
				<Suspense fallback={null}>
					<CommandBar
						open={commandBarOpen}
						onOpenChange={handleCommandBarOpenChange}
						files={workspace.files}
						folders={workspace.folders}
						workspacePath={workspace.workspacePath}
						recentWorkspaces={workspace.recentWorkspaces}
						currentPath={state.currentPath}
						moveSourcePath={commandBarMoveSourcePath}
						onOpenFile={openCommandBarFile}
						onOpenWorkspace={openCommandBarWorkspace}
						onOpenNotionResult={openNotionResult}
						onMoveFileToFolder={moveFileToFolderWithoutNotionRefresh}
						onRequestMoveCurrentFile={openMoveCurrentFileCommandBar}
					/>
				</Suspense>
			) : null}
			<NotionLoadingIndicator label={notionLoadingLabel} />
		</main>
	);
}

function NotionLoadingIndicator({ label }: { label: string | null }) {
	if (!label) return null;

	return (
		<div
			aria-live="assertive"
			aria-busy="true"
			className="fixed inset-0 z-[60] flex items-center justify-center bg-background/40 backdrop-blur-[2px] animate-in fade-in-0 duration-150"
		>
			<div className="flex items-center gap-3 rounded-[var(--radius-popover)] border border-border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-overlay">
				<MingcuteLoading3Line
					aria-hidden="true"
					className="size-4 animate-spin text-muted-foreground"
				/>
				<span className="font-medium">{label}</span>
			</div>
		</div>
	);
}

export default App;
