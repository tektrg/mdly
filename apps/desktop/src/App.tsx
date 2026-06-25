import { Button } from "@hubble.md/ui";
import { useStoreValue } from "@simplestack/store/react";
import { keymatch } from "keymatch";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DocumentViewer } from "./components/DocumentViewer";
import {
	HtmlAppsDialog,
	SidebarHtmlAppsCallout,
} from "./components/HtmlAppsCallout";
import { NotionOpenDialog } from "./components/NotionOpenDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import {
	SidebarUpdateCallout,
	UpdatesSection,
} from "./components/UpdatesSection";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { desktopApi } from "./desktopApi";
import type { DesktopUpdateState } from "./desktopApi/types";
import {
	createMarkdownFile,
	currentNotionLinkStatus,
	hasLocalChangesSinceLastNotionSync,
	importNotionDatabase,
	openOrImportNotionPage,
	pushCurrentNotionPage,
	refreshCurrentNotionPage,
} from "./fileActions";
import { hasHubbleSkillsInstalled } from "./lib/hubbleSkills";
import { SIDEBAR_NAV_SELECTOR } from "./selectors";
import {
	createWorkspaceWithSidebar,
	forceKeepLocalEdits,
	getPendingRenameTarget,
	handleExternalFileChange,
	loadPath,
	openWorkspace,
	openWorkspaceWithSidebar,
	refreshFiles,
	refreshFilesDebounced,
	reloadFromDiskConflict,
	setSidebarOpen,
	setWorkspaceSwitcherOpen,
} from "./store/actions";
import {
	sidebarOpenStore,
	uiStore,
	viewerStore,
	workspacePathStore,
	workspaceStore,
} from "./store/state";

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

function App() {
	const state = useStoreValue(viewerStore);
	const workspacePath = useStoreValue(workspacePathStore);
	const sidebarOpen = useStoreValue(sidebarOpenStore);
	const hasWorkspace = workspacePath !== null;
	const [scrollContainerEl, setScrollContainerEl] =
		useState<HTMLDivElement | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
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
	const notionOpenRefreshPathRef = useRef<string | null>(null);

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

	const refreshNotionPage = useCallback(async () => {
		try {
			const hasLocalChanges = hasLocalChangesSinceLastNotionSync();
			if (hasLocalChanges) {
				const overwrite = window.confirm(
					"This local file has changes that are not pushed to Notion. Replace it with the latest Notion page?",
				);
				if (!overwrite) return;
			}
			const refreshed = await refreshCurrentNotionPage({
				forceLocalOverwrite: hasLocalChanges,
			});
			if (refreshed) toast.success("Refreshed from Notion");
		} catch (error) {
			toast.error("Failed to refresh from Notion", {
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

		if (!currentNotionLinkStatus()) return;
		let disposed = false;
		const refreshFromOpen = async () => {
			try {
				const hasLocalChanges = hasLocalChangesSinceLastNotionSync();
				if (hasLocalChanges) {
					const overwrite = window.confirm(
						"This linked Notion file has local changes that are not pushed. Replace it with the latest Notion page?",
					);
					if (!overwrite || disposed) return;
				}
				await refreshCurrentNotionPage({
					forceLocalOverwrite: hasLocalChanges,
				});
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

	useEffect(() => {
		void desktopApi.setMenuState({ hasWorkspace });
	}, [hasWorkspace]);

	useEffect(() => {
		if (!sidebarOpen) setFocusedSidebarPath(null);
	}, [sidebarOpen]);

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
			} else if (keymatch(event, "CmdOrCtrl+Shift+N")) {
				event.preventDefault();
				await openWorkspaceWithSidebar();
			} else if (keymatch(event, "CmdOrCtrl+O")) {
				event.preventDefault();
				await openFilePicker();
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
				const opening = !uiStore.get().sidebarOpen;
				setSidebarOpen(opening);
				if (opening) {
					requestAnimationFrame(() => focusSidebarNav());
				}
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [focusedSidebarPath, openFilePicker, openSettings]);

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
			const nextState = viewerStore.get();
			const workspace = workspaceStore.get();
			const lastPath =
				nextState.lastOpenedPath ??
				(workspace.workspacePath
					? workspace.lastOpenedPaths[workspace.workspacePath]
					: undefined);
			if (lastPath) {
				await loadPath(lastPath);
			}
		};
		void init();
		return () => {
			active = false;
		};
	}, []);

	return (
		<main className="flex h-dvh flex-col bg-background text-foreground">
			<Toolbar
				scrollContainer={scrollContainerEl}
				showSidebarBadge={!sidebarOpen && showUpdateCallout}
				onOpenNotionPage={() => setNotionDialogOpen(true)}
				onPushNotionPage={pushNotionPage}
				onRefreshNotionPage={refreshNotionPage}
				showNotionSyncActions={notionLink !== null}
			/>
			<div className="flex min-h-0 flex-1 overflow-hidden">
				<Sidebar
					onFocusedPathChange={setFocusedSidebarPath}
					footer={
						updateState?.status === "ready" && showUpdateCallout ? (
							<SidebarUpdateCallout
								onInstall={installUpdate}
								onDismiss={() =>
									setDismissedVersion(readyVersion ?? "__unknown__")
								}
							/>
						) : htmlAppsCalloutVisible ? (
							<SidebarHtmlAppsCallout
								onShowMore={() => setHtmlAppsDialogOpen(true)}
								onDismiss={dismissHtmlAppsCallout}
							/>
						) : undefined
					}
				/>
				<section className="flex-1 overflow-hidden" aria-live="polite">
					{state.status === "loading" && <p>Loading…</p>}
					{state.status === "error" && (
						<p>{state.error ?? "Failed to open file."}</p>
					)}
					{state.status !== "loading" &&
						state.status !== "error" &&
						!state.currentPath && (
							<div className="flex h-full items-center justify-center p-6">
								{hasWorkspace ? (
									<Button onClick={() => void openFilePicker()}>
										Open file
									</Button>
								) : (
									<WelcomeScreen
										onCreateFolder={() => void createWorkspaceWithSidebar()}
										onOpenFolder={() => void openWorkspaceWithSidebar()}
									/>
								)}
							</div>
						)}
					{state.status === "ready" && state.currentPath && (
						<div className="flex h-full min-h-0 flex-col">
							{state.externalChange.kind === "conflict" && (
								<ExternalChangeBanner
									onKeepMyEdits={() => void forceKeepLocalEdits()}
									onReloadFromDisk={reloadFromDiskConflict}
								/>
							)}
							<DocumentViewer
								path={state.currentPath}
								content={state.content}
								onScrollContainerChange={setScrollContainerEl}
							/>
						</div>
					)}
				</section>
			</div>
			<SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen}>
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
			<NotionOpenDialog
				open={notionDialogOpen}
				onOpenChange={setNotionDialogOpen}
				onImportDatabase={async (result) => {
					await importNotionDatabase(result, {
						folderPath: focusedSidebarPath,
					});
					toast.success("Notion table imported");
				}}
				onImportPage={async (result) => {
					await openOrImportNotionPage(result, {
						folderPath: focusedSidebarPath,
					});
					toast.success("Notion page opened");
				}}
			/>
		</main>
	);
}

function ExternalChangeBanner({
	onReloadFromDisk,
	onKeepMyEdits,
}: {
	onReloadFromDisk: () => void;
	onKeepMyEdits: () => void;
}) {
	return (
		<div className="border-b border-border bg-muted/40">
			<div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
				<p className="m-0 text-sm text-muted-foreground">
					File changed on disk. Reload it or keep your editor edits.
				</p>
				<div className="flex shrink-0 items-center gap-2">
					<Button size="sm" variant="outline" onClick={onReloadFromDisk}>
						Reload from disk
					</Button>
					<Button size="sm" onClick={onKeepMyEdits}>
						Keep my edits
					</Button>
				</div>
			</div>
		</div>
	);
}

export default App;
