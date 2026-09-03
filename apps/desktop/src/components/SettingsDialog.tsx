import { Modal } from "@hubble.md/ui";
import { useStoreValue } from "@simplestack/store/react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { desktopApi } from "../desktopApi";
import type {
	CloudSyncStatus,
	CloudSyncWorkspaceState,
} from "../desktopApi/types";
import {
	CONTRAST_PREFERENCES,
	type ContrastPreference,
	type EditorFontPreference,
	SYSTEM_EDITOR_FONT_PREFERENCE,
	THEME_PREFERENCES,
	type ThemePreference,
} from "../lib/theme";
import {
	setContrastPreference,
	setEditorFontPreference,
	setShowIgnoredWorkspaceFiles,
	setSourceRetentionPreference,
	setThemePreference,
} from "../store/actions";
import type { SourceRetentionPreference } from "../store/persistence";
import {
	contrastPreferenceStore,
	editorFontPreferenceStore,
	showIgnoredWorkspaceFilesStore,
	sourceRetentionPreferenceStore,
	themePreferenceStore,
} from "../store/state";

export function SettingsDialog({
	open,
	onOpenChange,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	children: ReactNode;
}) {
	return (
		<Modal
			open={open}
			onOpenChange={onOpenChange}
			title="Settings"
			className="max-w-2xl"
		>
			<div className="flex flex-col gap-4">{children}</div>
		</Modal>
	);
}

export function SettingsSection({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children: ReactNode;
}) {
	return (
		<section className="flex flex-col gap-3">
			<div className="flex flex-col gap-1">
				<h3 className="text-sm font-semibold">{title}</h3>
				{description ? (
					<p className="text-xs text-muted-foreground">{description}</p>
				) : null}
			</div>
			<div>{children}</div>
		</section>
	);
}

const themePreferenceLabels: Record<ThemePreference, string> = {
	system: "System",
	light: "Light",
	dark: "Dark",
};

const contrastPreferenceLabels: Record<ContrastPreference, string> = {
	soft: "Soft",
	standard: "Standard",
	crisp: "Crisp",
};

const segmentedControlItemClassName =
	"inline-flex h-7 min-w-14 items-center justify-center rounded-sm px-2 text-[11px] font-medium text-muted-foreground transition-[color,background-color,box-shadow] duration-[var(--default-transition-duration)] ease-snappy select-none peer-checked:bg-card peer-checked:text-foreground peer-focus-visible:ring-1 peer-focus-visible:ring-ring/40 peer-focus-visible:outline-hidden";

const fallbackEditorFontFamilies = [
	"Avenir Next",
	"Georgia",
	"Helvetica Neue",
	"Menlo",
	"Monaco",
	"New York",
	"SF Mono",
	"Times New Roman",
];

function contrastPreferenceFromSliderValue(value: string): ContrastPreference {
	const preference = CONTRAST_PREFERENCES[Number(value)];
	return preference ?? "standard";
}

function contrastPreferenceToSliderValue(preference: ContrastPreference) {
	return CONTRAST_PREFERENCES.indexOf(preference);
}

function normalizeFontFamilies(fontFamilies: string[]) {
	return [
		...new Set(fontFamilies.map((family) => family.trim()).filter(Boolean)),
	].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function useEditorFontFamilies(selectedFont: EditorFontPreference) {
	const [fontFamilies, setFontFamilies] = useState(() =>
		normalizeFontFamilies(fallbackEditorFontFamilies),
	);
	const [loading, setLoading] = useState(false);
	const [osFontsLoaded, setOsFontsLoaded] = useState(false);

	useEffect(() => {
		if (typeof window.queryLocalFonts !== "function") return;

		let cancelled = false;
		setLoading(true);
		void window
			.queryLocalFonts()
			.then((fonts) => {
				if (cancelled) return;
				const families = normalizeFontFamilies(
					fonts.map((font) => font.family),
				);
				if (families.length > 0) {
					setFontFamilies(families);
					setOsFontsLoaded(true);
				}
			})
			.catch(() => {
				// Keep the fallback list when the OS/browser denies font access.
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, []);

	return {
		fontFamilies: useMemo(() => {
			if (selectedFont === SYSTEM_EDITOR_FONT_PREFERENCE) return fontFamilies;
			if (osFontsLoaded) return fontFamilies;
			return normalizeFontFamilies([...fontFamilies, selectedFont]);
		}, [fontFamilies, osFontsLoaded, selectedFont]),
		loading,
		osFontsLoaded,
	};
}

export function AppearanceSettings() {
	const themePreference = useStoreValue(themePreferenceStore);
	const contrastPreference = useStoreValue(contrastPreferenceStore);
	const editorFontPreference = useStoreValue(editorFontPreferenceStore);
	const contrastLabel = contrastPreferenceLabels[contrastPreference];
	const {
		fontFamilies,
		loading: editorFontsLoading,
		osFontsLoaded,
	} = useEditorFontFamilies(editorFontPreference);

	useEffect(() => {
		if (!osFontsLoaded) return;
		if (editorFontPreference === SYSTEM_EDITOR_FONT_PREFERENCE) return;
		if (fontFamilies.includes(editorFontPreference)) return;
		setEditorFontPreference(SYSTEM_EDITOR_FONT_PREFERENCE);
	}, [editorFontPreference, fontFamilies, osFontsLoaded]);

	return (
		<SettingsSection title="Appearance">
			<div className="flex flex-wrap items-end gap-4">
				<fieldset className="inline-grid grid-cols-3 rounded-sm border border-border bg-muted/50 p-0.5">
					<legend className="sr-only">Theme</legend>
					{THEME_PREFERENCES.map((preference) => {
						return (
							<label
								className="relative inline-flex cursor-pointer"
								key={preference}
							>
								<input
									checked={preference === themePreference}
									className="peer sr-only"
									name="theme-preference"
									onChange={() => setThemePreference(preference)}
									type="radio"
									value={preference}
								/>
								<span className={segmentedControlItemClassName}>
									{themePreferenceLabels[preference]}
								</span>
							</label>
						);
					})}
				</fieldset>
				<label className="flex min-w-48 flex-col gap-1.5">
					<span className="flex items-center justify-between gap-3 text-[11px] font-medium text-muted-foreground">
						Contrast
						<output className="tabular-nums text-foreground">
							{contrastLabel}
						</output>
					</span>
					<input
						aria-valuetext={contrastLabel}
						className="h-7 w-48 cursor-pointer [accent-color:var(--ring)]"
						max={CONTRAST_PREFERENCES.length - 1}
						min={0}
						onChange={(event) =>
							setContrastPreference(
								contrastPreferenceFromSliderValue(event.currentTarget.value),
							)
						}
						step={1}
						type="range"
						value={contrastPreferenceToSliderValue(contrastPreference)}
					/>
					<span
						aria-hidden="true"
						className="grid w-48 grid-cols-3 text-[10px] leading-none text-muted-foreground"
					>
						<span>Soft</span>
						<span className="text-center">Standard</span>
						<span className="text-right">Crisp</span>
					</span>
				</label>
				<label className="flex min-w-64 flex-col gap-1.5">
					<span className="flex items-center justify-between gap-3 text-[11px] font-medium text-muted-foreground">
						Editor font
						{editorFontsLoading ? (
							<span className="font-normal">Loading</span>
						) : null}
					</span>
					<select
						className="h-8 w-64 rounded-sm border border-input bg-card px-2 text-[11px] text-foreground outline-hidden transition-[border-color,box-shadow] duration-[var(--default-transition-duration)] ease-snappy focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/40"
						onChange={(event) =>
							setEditorFontPreference(event.currentTarget.value)
						}
						value={editorFontPreference}
					>
						<option value={SYSTEM_EDITOR_FONT_PREFERENCE}>System</option>
						{fontFamilies.map((fontFamily) => (
							<option key={fontFamily} value={fontFamily}>
								{fontFamily}
							</option>
						))}
					</select>
				</label>
			</div>
		</SettingsSection>
	);
}

export function WorkspaceSettings() {
	const showIgnoredWorkspaceFiles = useStoreValue(
		showIgnoredWorkspaceFilesStore,
	);

	return (
		<SettingsSection
			title="Workspace"
			description="Controls which workspace files appear in the sidebar."
		>
			<label className="flex items-start justify-between gap-4 rounded-sm border border-border bg-card [padding-block:0.625rem] [padding-inline:0.75rem]">
				<span className="flex min-w-0 flex-col gap-1">
					<span className="text-[11px] font-medium text-foreground">
						Show ignored files
					</span>
					<span className="text-[11px] leading-4 text-muted-foreground">
						Includes Markdown and HTML files ignored by .gitignore or .ignore.
					</span>
				</span>
				<input
					checked={showIgnoredWorkspaceFiles}
					className="mt-0.5 size-4 shrink-0 cursor-pointer [accent-color:var(--ring)]"
					onChange={(event) =>
						setShowIgnoredWorkspaceFiles(event.currentTarget.checked)
					}
					type="checkbox"
				/>
			</label>
		</SettingsSection>
	);
}

const sourceRetentionPreferenceLabels: Record<
	SourceRetentionPreference,
	string
> = {
	ask: "Ask every time",
	keep: "Keep a copy",
	delete: "Discard source",
};

export function ImportSettings() {
	const sourceRetentionPreference = useStoreValue(
		sourceRetentionPreferenceStore,
	);

	return (
		<SettingsSection
			title="Import"
			description="How imported documents remember their original file."
		>
			<label className="flex items-start justify-between gap-4 rounded-sm border border-border bg-card [padding-block:0.625rem] [padding-inline:0.75rem]">
				<span className="flex min-w-0 flex-col gap-1">
					<span className="text-[11px] font-medium text-foreground">
						Keep source document
					</span>
					<span className="text-[11px] leading-4 text-muted-foreground">
						Keeping the original lets you re-import later, including recovering
						images when import fidelity improves.
					</span>
				</span>
				<select
					className="h-8 w-40 shrink-0 rounded-sm border border-input bg-card px-2 text-[11px] text-foreground outline-hidden"
					value={sourceRetentionPreference}
					onChange={(event) =>
						setSourceRetentionPreference(
							event.currentTarget.value as SourceRetentionPreference,
						)
					}
				>
					{(
						Object.keys(
							sourceRetentionPreferenceLabels,
						) as SourceRetentionPreference[]
					).map((preference) => (
						<option key={preference} value={preference}>
							{sourceRetentionPreferenceLabels[preference]}
						</option>
					))}
				</select>
			</label>
		</SettingsSection>
	);
}

// Matches `packages/cli`'s own default (`getWorkerUrl` in
// `packages/cli/src/index.ts`) so the desktop app and the CLI agree on where
// an unconfigured workspace's Worker lives during local development.
const DEFAULT_CLOUD_SYNC_DEPLOYMENT_URL = "http://127.0.0.1:8787";

// Mirrors `DEFAULT_CLOUD_SYNC_EXCLUDED_DIR_NAMES` in
// `apps/desktop/electron/cloudSyncWiring.ts` — the renderer cannot import the
// main-process module (it pulls in chokidar and the Node filesystem), so the
// "Reset to defaults" button keeps its own copy, the same way
// `DEFAULT_CLOUD_SYNC_DEPLOYMENT_URL` above mirrors the CLI's default. What is
// actually in force always comes from `state.excludedFolders` over IPC; this
// list is only what Reset types into the box.
const DEFAULT_CLOUD_SYNC_EXCLUDED_FOLDERS = [
	".git",
	"node_modules",
	"dist",
	".dev-electron",
	".hubble",
	".mdly",
	".claude",
];

const CLOUD_SYNC_STATUS_LABELS: Record<CloudSyncStatus, string> = {
	off: "Off",
	connecting: "Connecting…",
	syncing: "Syncing…",
	idle: "Up to date",
	error: "Error",
	"needs-reauth": "Needs re-authentication",
	"workspace-unavailable": "Workspace unavailable",
	"workspace-too-large": "Workspace too large to sync",
};

function workspaceNameFromPath(workspacePath: string): string {
	const segments = workspacePath.split(/[\\/]+/).filter(Boolean);
	return segments[segments.length - 1] ?? workspacePath;
}

/**
 * Phase 1 Cloud Sync (charter R19-R30): the per-workspace opt-in switch
 * (D5/R27) plus the sync-status indicator (R29, R30). Renders nothing when
 * no workspace is open — Cloud Sync is meaningless outside a workspace. The
 * bearer password (R20) is entered here but never stored in this component's
 * own state beyond the pending submit — it's handed straight to
 * `desktopApi.enableCloudSync`, which the main process stores only in the
 * macOS Keychain.
 */
export function CloudSyncSettings({
	workspacePath,
}: {
	workspacePath: string | null;
}) {
	const [state, setState] = useState<CloudSyncWorkspaceState | null>(null);
	const [deploymentUrl, setDeploymentUrl] = useState(
		DEFAULT_CLOUD_SYNC_DEPLOYMENT_URL,
	);
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [excludedFoldersDraft, setExcludedFoldersDraft] = useState("");
	const [savedExcludedFolders, setSavedExcludedFolders] = useState<string[]>(
		[],
	);

	// The draft textarea and the "everything is watched" warning both follow
	// whatever the main process reports as EFFECTIVE, so neither can drift from
	// the list the watcher is really pruning.
	function adoptExcludedFolders(folders: string[]) {
		setSavedExcludedFolders(folders);
		setExcludedFoldersDraft(folders.join("\n"));
	}

	useEffect(() => {
		if (!workspacePath) {
			setState(null);
			return;
		}
		let cancelled = false;
		void desktopApi.getCloudSyncState(workspacePath).then((initial) => {
			if (cancelled) return;
			setState(initial);
			if (initial.deploymentUrl) setDeploymentUrl(initial.deploymentUrl);
			setSavedExcludedFolders(initial.excludedFolders);
			setExcludedFoldersDraft(initial.excludedFolders.join("\n"));
		});
		let unsubscribe: (() => void) | undefined;
		void desktopApi
			.onCloudSyncStatusChange(workspacePath, (status, detail) => {
				if (cancelled) return;
				setState((prev) => (prev ? { ...prev, status, detail } : prev));
			})
			.then((fn) => {
				if (cancelled) fn();
				else unsubscribe = fn;
			});
		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, [workspacePath]);

	if (!workspacePath || !state) return null;

	const handleEnable = async () => {
		setBusy(true);
		setActionError(null);
		try {
			const next = await desktopApi.enableCloudSync(workspacePath, {
				workspaceName: workspaceNameFromPath(workspacePath),
				deploymentUrl,
				password: password.length > 0 ? password : undefined,
			});
			setState(next);
			adoptExcludedFolders(next.excludedFolders);
			setPassword("");
		} catch (error) {
			setActionError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const handleDisable = async () => {
		setBusy(true);
		setActionError(null);
		try {
			const result = await desktopApi.disableCloudSync(workspacePath);
			setState((prev) => {
				if (!prev) return prev;
				// Only claim "off" when the cloud copy is actually gone. When the
				// delete failed, cloudSyncWiring has already pushed an explicit
				// "error" status plus reason through the status channel, and that
				// event lands BEFORE this invoke resolves -- so overwriting it with
				// "off" here would tell the user the copy was removed when it was
				// not (R36 honesty requirement).
				if (!result.cloudCopyDeleted) return { ...prev, backgroundSync: false };
				return { ...prev, backgroundSync: false, status: "off" };
			});
		} catch (error) {
			setActionError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const handleSaveExcludedFolders = async () => {
		setBusy(true);
		setActionError(null);
		try {
			const next = await desktopApi.setCloudSyncExcludedFolders(
				workspacePath,
				excludedFoldersDraft.split("\n"),
			);
			setState(next);
			adoptExcludedFolders(next.excludedFolders);
		} catch (error) {
			setActionError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const needsPassword =
		!state.backgroundSync || state.status === "needs-reauth";

	return (
		<SettingsSection
			title="Cloud Sync"
			description="Read this workspace from any browser at your shared Cloud Sync password. Off by default per workspace."
		>
			<div className="flex flex-col gap-3 rounded-sm border border-border bg-card [padding-block:0.625rem] [padding-inline:0.75rem]">
				<div className="flex items-start justify-between gap-4">
					<span className="flex min-w-0 flex-col gap-1">
						<span className="text-[11px] font-medium text-foreground">
							Sync this workspace to the cloud
						</span>
						<span className="text-[11px] leading-4 text-muted-foreground">
							{CLOUD_SYNC_STATUS_LABELS[state.status]}
							{state.detail ? ` — ${state.detail}` : ""}
						</span>
					</span>
					<button
						className="h-8 shrink-0 rounded-sm border border-input bg-card px-3 text-[11px] text-foreground outline-hidden disabled:opacity-50"
						disabled={busy}
						onClick={() =>
							void (state.backgroundSync ? handleDisable() : handleEnable())
						}
						type="button"
					>
						{state.backgroundSync ? "Disable" : "Enable"}
					</button>
				</div>
				{needsPassword && (
					<div className="flex flex-col gap-2">
						<label className="flex flex-col gap-1">
							<span className="text-[11px] text-muted-foreground">
								Deployment URL
							</span>
							<input
								className="h-8 rounded-sm border border-input bg-card px-2 text-[11px] text-foreground outline-hidden"
								disabled={busy || state.backgroundSync}
								onChange={(event) =>
									setDeploymentUrl(event.currentTarget.value)
								}
								type="text"
								value={deploymentUrl}
							/>
						</label>
						<label className="flex flex-col gap-1">
							<span className="text-[11px] text-muted-foreground">
								{state.status === "needs-reauth"
									? "Cloud Sync password (rotated on another device — re-enter it here)"
									: "Cloud Sync password (leave blank to reuse the one already in Keychain)"}
							</span>
							<input
								className="h-8 rounded-sm border border-input bg-card px-2 text-[11px] text-foreground outline-hidden"
								disabled={busy}
								onChange={(event) => setPassword(event.currentTarget.value)}
								type="password"
								value={password}
							/>
						</label>
						{state.status === "needs-reauth" && (
							<button
								className="h-8 w-fit shrink-0 rounded-sm border border-input bg-card px-3 text-[11px] text-foreground outline-hidden disabled:opacity-50"
								disabled={busy || password.length === 0}
								onClick={() => void handleEnable()}
								type="button"
							>
								Reconnect
							</button>
						)}
					</div>
				)}
				<div className="flex flex-col gap-2">
					<label className="flex flex-col gap-1">
						<span className="text-[11px] font-medium text-foreground">
							Folders never synced
						</span>
						<span className="text-[11px] leading-4 text-muted-foreground">
							Anything inside a folder with one of these names stays on this Mac
							and is never watched or uploaded. Agent worktrees (.claude) and
							dependency folders belong here — watching them can freeze the app.
							One folder name per line.
						</span>
						<textarea
							className="min-h-24 rounded-sm border border-input bg-card px-2 py-1.5 text-[11px] leading-4 text-foreground outline-hidden disabled:opacity-50"
							disabled={busy}
							onChange={(event) =>
								setExcludedFoldersDraft(event.currentTarget.value)
							}
							spellCheck={false}
							value={excludedFoldersDraft}
						/>
					</label>
					<div className="flex flex-wrap items-center gap-2">
						<button
							className="h-8 shrink-0 rounded-sm border border-input bg-card px-3 text-[11px] text-foreground outline-hidden disabled:opacity-50"
							disabled={busy}
							onClick={() => void handleSaveExcludedFolders()}
							type="button"
						>
							Save folder list
						</button>
						<button
							className="h-8 shrink-0 rounded-sm border border-input bg-card px-3 text-[11px] text-foreground outline-hidden disabled:opacity-50"
							disabled={busy}
							onClick={() =>
								setExcludedFoldersDraft(
									DEFAULT_CLOUD_SYNC_EXCLUDED_FOLDERS.join("\n"),
								)
							}
							type="button"
						>
							Reset to defaults
						</button>
					</div>
					{savedExcludedFolders.length === 0 && (
						<span className="text-[11px] leading-4 text-foreground">
							Nothing is excluded — every folder in this workspace, including
							agent worktrees and dependency folders, will be watched and
							uploaded.
						</span>
					)}
				</div>
				{actionError && (
					<span className="text-[11px] leading-4 text-destructive">
						{actionError}
					</span>
				)}
			</div>
		</SettingsSection>
	);
}
