import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import hubbleRuntime from "@hubble.md/runtime/global.js?raw";
import htmlAppTheme from "@hubble.md/runtime/html-app-theme.css?raw";
import tailwindRuntime from "@tailwindcss/browser?raw";
import alpineRuntime from "alpinejs/dist/cdn.min.js?raw";
import chokidar, { type FSWatcher } from "chokidar";
import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	Menu,
	protocol,
	screen,
	session,
	shell,
} from "electron";
import ignore from "ignore";
import { z } from "zod/v4";
import type {
	DesktopUpdateState,
	DirectoryListing,
	WorkspaceConfig,
} from "../src/desktopApi/types";
import {
	hasDocumentExtension,
	hasMarkdownExtension,
	markdownAssetFolderPath,
	withMarkdownExtension,
} from "../src/lib/filePath";
import {
	listCommentThreadsForPath,
	openCommentThreadForPath,
	reopenCommentThreadForPath,
	replyToCommentThreadForPath,
	resolveCommentThreadForPath,
} from "./comments";
import { recordCrashTraceEvent, startCrashTrace } from "./crashTrace";
import {
	createSelfWriteEchoTracker,
	getHistoryStoreForWorkspace,
	type InAppHistoryCause,
	loadOrCreateActorId,
	recordDeleteHistory,
	recordExternalWriteHistory,
	recordInAppWriteHistory,
	recordRenameHistory,
	resolveHistoryWorkspaceRoot,
	toWorkspaceRelativePath,
} from "./docHistoryWiring";
import {
	acquireDocSource,
	checkConverterStatus,
	convertDocFile,
} from "./docImport";
import { ensureLoginShellPathMerged } from "./externalCommand";
import { collectDocumentFiles } from "./fileDiscovery";
import { scanFrontMatterTags } from "./frontMatterTags";
import {
	getNotionConnectionStatus,
	getNotionPageMarkdown,
	queryNotionDatabase,
	searchNotion,
	setNotionAccount,
	updateNotionPageMarkdown,
} from "./notion";
import {
	loadZoomFactor,
	resetWindowZoom,
	setTrafficLightInset,
	stepWindowZoom,
	trafficLightPositionForZoom,
	zoomStep,
} from "./zoom";

type HtmlAppFileEntry = {
	name: string;
	path: string;
	modified_at: number;
	size: number;
};

type MenuState = {
	hasWorkspace: boolean;
};

type IgnoreRule = {
	dir: string;
	matcher: ReturnType<typeof ignore>;
};

type HtmlAppAsset = {
	name: string;
	source: string;
};

type WindowState = {
	width: number;
	height: number;
	x?: number;
	y?: number;
	isMaximized?: boolean;
	isFullScreen?: boolean;
};

type WindowBounds = {
	x: number;
	y: number;
	width: number;
	height: number;
};

const isDev = !app.isPackaged || process.env.HUBBLE_DESKTOP_FORCE_DEV === "1";

// electron-updater is loaded lazily instead of imported at module load. Auto
// updates are disabled (supportsAutoUpdates === false), so this dependency is
// never needed at runtime and is intentionally NOT bundled into the packaged
// app (see electron.vite.config.ts). Every caller sits behind the
// supportsAutoUpdates guard, so a packaged build never reaches this import.
async function loadAutoUpdater(): Promise<
	import("electron-updater").AppUpdater
> {
	const electronUpdater = (await import("electron-updater")).default;
	return electronUpdater.autoUpdater;
}
const devAppName = isDev ? process.env.HUBBLE_DESKTOP_DEV_APP_NAME : undefined;
const appName = devAppName ?? "mdly";
const debugPort = process.env.HUBBLE_DESKTOP_DEBUG_PORT ?? "9222";

// Home URL of the packaged renderer. Served from the privileged `app://` scheme
// (registered above) so the page has a real tuple origin and a secure context,
// instead of file://'s opaque "null" origin.
const rendererAppUrl = "app://mdly/index.html";
// Directory the packaged renderer build is copied to inside the app bundle.
// __dirname is out/main at runtime, so the renderer lives one level up.
const rendererDir = path.join(__dirname, "../renderer");
const updateFeedUrl = process.env.HUBBLE_DESKTOP_UPDATE_URL;
const supportsAutoUpdates = false;
const devHttpCacheSizeBytes = 10 * 1024 * 1024;
// Check every 4 hours after the initial packaged-app update check.
const updateCheckIntervalMs = 4 * 60 * 60 * 1000;

app.setName(appName);
if (devAppName) {
	app.setPath("userData", path.join(app.getPath("appData"), devAppName));
}

if (isDev && process.env.HUBBLE_DESKTOP_ENABLE_CDP === "1") {
	app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
	app.commandLine.appendSwitch("remote-debugging-port", debugPort);
}
if (isDev) {
	app.commandLine.appendSwitch(
		"disk-cache-size",
		String(devHttpCacheSizeBytes),
	);
}

let mainWindow: BrowserWindow | null = null;
let saveWindowStateTimer: ReturnType<typeof setTimeout> | null = null;
let pendingOpenPath: string | null = firstExistingFileArg(
	process.argv.slice(1),
);
const launchWorkspacePath =
	isDev && process.env.HUBBLE_DESKTOP_DEV_WORKSPACE
		? resolvePath(process.env.HUBBLE_DESKTOP_DEV_WORKSPACE)
		: null;
let menuState: MenuState = { hasWorkspace: false };
let updateState: DesktopUpdateState = {
	isSupported: supportsAutoUpdates,
	status: "idle",
	currentVersion: app.getVersion(),
	availableVersion: null,
	progressPercent: null,
	message: supportsAutoUpdates
		? null
		: "Automatic updates are disabled for this build.",
	lastCheckedAt: null,
};
const watchers = new Map<string, FSWatcher>();
const grantedFiles = new Set<string>();
const grantedRoots = new Set<string>();
let grantsLoaded = false;
const historyEchoTracker = createSelfWriteEchoTracker();
let actorIdPromise: Promise<string> | null = null;

const IN_APP_HISTORY_CAUSES = new Set<InAppHistoryCause>([
	"idle-session",
	"manual",
	"import",
	"restore",
]);

function isInAppHistoryCause(value: unknown): value is InAppHistoryCause {
	return (
		typeof value === "string" &&
		IN_APP_HISTORY_CAUSES.has(value as InAppHistoryCause)
	);
}

/** Loaded once per process and cached — persisted next to `grants.json`. */
function getActorId(): Promise<string> {
	if (!actorIdPromise) {
		actorIdPromise = loadOrCreateActorId(app.getPath("userData"));
	}
	return actorIdPromise;
}

const ignoreConfigFiles = [".gitignore", ".ignore"];
const ignoredWorkspaceDirs = new Set([
	".dev-electron",
	".git",
	"dist",
	"node_modules",
]);
const workspaceConfigVersion = 1;
const workspaceConfigDir = ".hubble";
const workspaceConfigFile = "config.json";
const workspaceConfigSchema = z.object({
	version: z.literal(workspaceConfigVersion),
	pinnedNotes: z.array(
		z
			.string()
			.min(1)
			// Pin refs live inside the workspace config; reject absolute paths and
			// traversal so config edits cannot point pin state outside the workspace.
			.refine(
				(note) => !path.isAbsolute(note) && !note.split("/").includes(".."),
			),
	),
});
const defaultWindowState: WindowState = { width: 920, height: 720 };
const windowStateSchema = z.object({
	width: z.number().int().min(640).max(4096),
	height: z.number().int().min(480).max(4096),
	x: z.number().int().optional(),
	y: z.number().int().optional(),
	isMaximized: z.boolean().optional(),
	isFullScreen: z.boolean().optional(),
});
const htmlAppHeadStyles = [
	{ name: "hubble-theme", source: htmlAppTheme },
] as const;
const htmlAppHeadScripts = [
	{ name: "hubble-runtime", source: hubbleRuntime },
	{ name: "tailwind-browser", source: tailwindRuntime },
] as const;
// Alpine's CDN build auto-starts immediately; inline scripts cannot use defer.
const htmlAppBodyEndScripts = [
	{ name: "alpine", source: alpineRuntime },
] as const;

function grantsPath(): string {
	return path.join(app.getPath("userData"), "grants.json");
}

function windowStatePath(): string {
	return path.join(app.getPath("userData"), "window-size.json");
}

function workspaceConfigPath(workspacePath: string): string {
	const root = assertGrantedRoot(workspacePath);
	return path.join(root, workspaceConfigDir, workspaceConfigFile);
}

function emptyWorkspaceConfig(): WorkspaceConfig {
	return { version: workspaceConfigVersion, pinnedNotes: [] };
}

function parseWorkspaceConfig(raw: string): WorkspaceConfig {
	try {
		return workspaceConfigSchema.parse(JSON.parse(raw));
	} catch {
		return emptyWorkspaceConfig();
	}
}

function normalizeWorkspaceConfig(input: WorkspaceConfig): WorkspaceConfig {
	const config = workspaceConfigSchema.safeParse(input);
	if (!config.success) return emptyWorkspaceConfig();
	return {
		version: workspaceConfigVersion,
		pinnedNotes: [...new Set(config.data.pinnedNotes)],
	};
}

async function loadGrants() {
	try {
		const raw = await fs.readFile(grantsPath(), "utf8");
		const parsed = JSON.parse(raw) as { files?: unknown; roots?: unknown };
		if (Array.isArray(parsed.files)) {
			for (const filePath of parsed.files) {
				if (typeof filePath === "string")
					grantedFiles.add(resolvePath(filePath));
			}
		}
		if (Array.isArray(parsed.roots)) {
			for (const rootPath of parsed.roots) {
				if (typeof rootPath === "string")
					grantedRoots.add(resolvePath(rootPath));
			}
		}
	} catch {
		// Missing or malformed grants just means the user must pick paths again.
	} finally {
		grantsLoaded = true;
	}
}

async function saveGrants() {
	if (!grantsLoaded) return;
	await fs.mkdir(path.dirname(grantsPath()), { recursive: true });
	await fs.writeFile(
		grantsPath(),
		JSON.stringify(
			{
				files: [...grantedFiles],
				roots: [...grantedRoots],
			},
			null,
			2,
		),
	);
}

async function loadWindowState(): Promise<WindowState> {
	try {
		const raw = await fs.readFile(windowStatePath(), "utf8");
		const parsed = windowStateSchema.safeParse(JSON.parse(raw));
		if (parsed.success) return resolveWindowState(parsed.data);
	} catch {
		// Missing or malformed window state should not block launch.
	}
	return defaultWindowState;
}

function resolveWindowState(state: WindowState): WindowState {
	if (
		state.x === undefined ||
		state.y === undefined ||
		!isVisibleWindowBounds({
			x: state.x,
			y: state.y,
			width: state.width,
			height: state.height,
		})
	) {
		return {
			...clampWindowSize(state, screen.getPrimaryDisplay().workArea),
			isMaximized: state.isMaximized,
			isFullScreen: state.isFullScreen,
		};
	}
	const bounds = {
		x: state.x,
		y: state.y,
		width: state.width,
		height: state.height,
	};
	return {
		...state,
		...clampWindowBounds(bounds, screen.getDisplayMatching(bounds).workArea),
	};
}

function clampWindowSize(
	{ width, height }: Pick<WindowState, "width" | "height">,
	workArea: { width: number; height: number },
) {
	return {
		width: Math.min(width, workArea.width),
		height: Math.min(height, workArea.height),
	};
}

function clampWindowBounds(bounds: WindowBounds, workArea: WindowBounds) {
	const size = clampWindowSize(bounds, workArea);
	return {
		...size,
		x: Math.min(
			Math.max(bounds.x, workArea.x),
			workArea.x + workArea.width - size.width,
		),
		y: Math.min(
			Math.max(bounds.y, workArea.y),
			workArea.y + workArea.height - size.height,
		),
	};
}

function isVisibleWindowBounds(bounds: WindowBounds) {
	return screen.getAllDisplays().some(({ workArea }) => {
		const visibleWidth =
			Math.min(bounds.x + bounds.width, workArea.x + workArea.width) -
			Math.max(bounds.x, workArea.x);
		const visibleHeight =
			Math.min(bounds.y + bounds.height, workArea.y + workArea.height) -
			Math.max(bounds.y, workArea.y);
		return (
			visibleWidth >= Math.min(160, bounds.width) &&
			visibleHeight >= Math.min(120, bounds.height)
		);
	});
}

function saveWindowState(window: BrowserWindow) {
	if (window.isDestroyed() || window.isMinimized()) return;
	const bounds = window.getNormalBounds();
	const parsed = windowStateSchema.safeParse({
		...bounds,
		isMaximized: window.isMaximized(),
		isFullScreen: window.isFullScreen(),
	});
	if (!parsed.success) return;
	try {
		fsSync.mkdirSync(path.dirname(windowStatePath()), { recursive: true });
		fsSync.writeFileSync(
			windowStatePath(),
			JSON.stringify(parsed.data, null, 2),
		);
	} catch {
		// Best-effort window state should not interrupt resize or app shutdown.
	}
}

function queueSaveWindowState(window: BrowserWindow) {
	if (saveWindowStateTimer) clearTimeout(saveWindowStateTimer);
	saveWindowStateTimer = setTimeout(() => {
		saveWindowStateTimer = null;
		saveWindowState(window);
	}, 300);
}

function resolvePath(input: string): string {
	if (typeof input !== "string" || input.trim().length === 0) {
		throw new Error("Path is required");
	}
	if (input === "~") return app.getPath("home");
	if (input.startsWith("~/") || input.startsWith("~\\")) {
		return path.resolve(app.getPath("home"), input.slice(2));
	}
	return path.resolve(input);
}

function grantFile(filePath: string) {
	grantedFiles.add(resolvePath(filePath));
	void saveGrants();
}

function grantRoot(rootPath: string) {
	grantedRoots.add(resolvePath(rootPath));
	void saveGrants();
}

function grantFileWithParent(filePath: string) {
	const resolved = resolvePath(filePath);
	grantFile(resolved);
	grantRoot(path.dirname(resolved));
}

function isWithin(rootPath: string, candidatePath: string): boolean {
	const relative = path.relative(rootPath, candidatePath);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

/**
 * Covers always-ignored workspace dirs in case Git ignores do not catch them.
 * Only segments below the workspace root count — if the workspace itself is
 * nested inside a folder like `.dev-electron`, that ancestor segment must not
 * cause every file in the workspace to be ignored.
 */
function isIgnoredWorkspacePath(candidatePath: string, root: string): boolean {
	const relative = path.relative(root, candidatePath);
	if (
		relative === "" ||
		relative.startsWith("..") ||
		path.isAbsolute(relative)
	) {
		return false;
	}
	return relative
		.split(/[\\/]+/)
		.some((segment) => ignoredWorkspaceDirs.has(segment));
}

function toIgnorePath(input: string): string {
	return input.split(path.sep).join("/");
}

function isIgnoredByRules(
	candidatePath: string,
	rules: IgnoreRule[],
	root: string,
) {
	if (isIgnoredWorkspacePath(candidatePath, root)) return true;

	let ignored = false;
	for (const { dir, matcher } of rules) {
		const relative = path.relative(dir, candidatePath);
		if (
			relative === "" ||
			relative.startsWith("..") ||
			path.isAbsolute(relative)
		)
			continue;
		const ignorePath = toIgnorePath(relative);
		const result = matcher.test(ignorePath);
		const directoryResult = matcher.test(`${ignorePath}/`);
		if (result.ignored || directoryResult.ignored) ignored = true;
		if (result.unignored || directoryResult.unignored) ignored = false;
	}
	return ignored;
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

async function rulesForDir(dir: string, inherited: IgnoreRule[]) {
	const matcher = ignore();
	let hasRules = false;

	for (const fileName of ignoreConfigFiles) {
		try {
			matcher.add(await fs.readFile(path.join(dir, fileName), "utf8"));
			hasRules = true;
		} catch (error) {
			if (isMissingPathError(error)) continue;
			throw error;
		}
	}

	return hasRules ? [...inherited, { dir, matcher }] : inherited;
}

function assertGranted(input: string): string {
	const resolved = resolvePath(input);
	if (grantedFiles.has(resolved)) return resolved;
	for (const root of grantedRoots) {
		if (isWithin(root, resolved)) return resolved;
	}
	throw new Error(`Path is outside granted scope: ${input}`);
}

function assertGrantedRoot(input: string): string {
	const resolved = assertGranted(input);
	grantRoot(resolved);
	return resolved;
}

async function pathExistsAsFile(input: string): Promise<boolean> {
	try {
		return (await fs.stat(input)).isFile();
	} catch {
		return false;
	}
}

async function pathExists(input: string): Promise<boolean> {
	try {
		await fs.stat(input);
		return true;
	} catch {
		return false;
	}
}

function firstExistingFileArg(args: string[]): string | null {
	for (const arg of args) {
		if (arg.startsWith("-")) continue;
		const resolved = path.resolve(arg);
		try {
			if (fsSync.statSync(resolved).isFile()) {
				grantFileWithParent(resolved);
				return resolved;
			}
		} catch {
			// Keep scanning.
		}
	}
	return null;
}

function sendToRenderer(channel: string, ...args: unknown[]) {
	mainWindow?.webContents.send(channel, ...args);
}

function assetPathFromUrl(url: URL): string {
	const queryPath = url.searchParams.get("path");
	if (queryPath) return queryPath;
	const encodedPath = url.pathname.startsWith("/")
		? url.pathname.slice(1)
		: url.pathname;
	return decodeURIComponent(encodedPath);
}

function assetContentType(filePath: string): string {
	switch (path.extname(filePath).toLowerCase()) {
		case ".css":
			return "text/css; charset=utf-8";
		case ".html":
			return "text/html; charset=utf-8";
		case ".js":
		case ".mjs":
			return "text/javascript; charset=utf-8";
		case ".json":
			return "application/json; charset=utf-8";
		case ".svg":
			return "image/svg+xml";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".png":
			return "image/png";
		case ".webp":
			return "image/webp";
		case ".woff":
			return "font/woff";
		case ".woff2":
			return "font/woff2";
		case ".ttf":
			return "font/ttf";
		case ".mp4":
			return "video/mp4";
		case ".ico":
			return "image/x-icon";
		case ".map":
			return "application/json; charset=utf-8";
		default:
			return "application/octet-stream";
	}
}

function scriptTag({ name, source }: HtmlAppAsset) {
	return `<script data-hubble-injected="${name}">\n${source}\n</script>`;
}

function styleTag({ name, source }: HtmlAppAsset) {
	return `<style data-hubble-injected="${name}" type="text/tailwindcss">\n${source}\n</style>`;
}

function insertBeforeCloseTag(html: string, tagName: string, content: string) {
	const closeIndex = html.search(new RegExp(`</${tagName}\\s*>`, "i"));
	if (closeIndex === -1) return `${html}${content}`;
	return `${html.slice(0, closeIndex)}${content}${html.slice(closeIndex)}`;
}

// Alpine directives appear as HTML attributes: x-*, @event="…", or :binding="…".
// The event/binding forms require `=` so CSS at-rules (@media, @font-face) and
// namespaced attributes inside inline <style>/<svg> don't trigger a false match.
const alpineDirectivePattern = /\sx-[a-z]|\s@[a-z-]+=|\s:[a-z-]+=/i;

function htmlUsesAlpine(html: string): boolean {
	return alpineDirectivePattern.test(html);
}

// The Tailwind browser compiler is only needed to compile utility classes or an
// inline `text/tailwindcss` block. Alpine can add classes at runtime, so keep
// the compiler whenever Alpine directives are present. Purely static HTML with
// no classes skips both heavy runtimes.
function htmlUsesTailwind(html: string): boolean {
	return (
		/type=["']text\/tailwindcss["']/i.test(html) ||
		/\sclass(?:Name)?=/i.test(html) ||
		htmlUsesAlpine(html)
	);
}

function injectHtmlAppRuntime(html: string): string {
	const wantsTailwind = htmlUsesTailwind(html);
	const wantsAlpine = htmlUsesAlpine(html);
	const headScriptAssets = htmlAppHeadScripts.filter(
		(asset) => asset.name !== "tailwind-browser" || wantsTailwind,
	);
	const bodyScriptAssets = htmlAppBodyEndScripts.filter(
		(asset) => asset.name !== "alpine" || wantsAlpine,
	);
	const headStyles = htmlAppHeadStyles.map(styleTag).join("\n");
	const headScripts = headScriptAssets.map(scriptTag).join("\n");
	const bodyEndScripts = bodyScriptAssets.map(scriptTag).join("\n");
	const headInjection = `\n${headStyles}\n${headScripts}\n`;
	const bodyEndInjection = bodyEndScripts ? `\n${bodyEndScripts}\n` : "";
	const withHead =
		html.search(/<\/head\s*>/i) === -1
			? `${headInjection}${html}`
			: insertBeforeCloseTag(html, "head", headInjection);
	return insertBeforeCloseTag(withHead, "body", bodyEndInjection);
}

function responseForAsset(filePath: string) {
	const contentType = assetContentType(filePath);
	const body = contentType.startsWith("text/html")
		? injectHtmlAppRuntime(fsSync.readFileSync(filePath, "utf8"))
		: fsSync.readFileSync(filePath);

	return new Response(body, {
		headers: {
			"cache-control": "no-store",
			"content-type": contentType,
		},
	});
}

function buildMenu() {
	const template: Electron.MenuItemConstructorOptions[] = [
		{
			label: "File",
			submenu: [
				{
					id: "new-markdown-file",
					label: "New File",
					accelerator: "CmdOrCtrl+N",
					click: () => sendToRenderer("desktop:menu-create-markdown-file"),
				},
				{
					id: "new-workspace",
					label: "Add Folder...",
					accelerator: "CmdOrCtrl+Shift+N",
					click: () => sendToRenderer("desktop:menu-open-folder"),
				},
				{ type: "separator" },
				{
					id: "open",
					label: "Open...",
					accelerator: "CmdOrCtrl+O",
					click: () => sendToRenderer("desktop:menu-open-file"),
				},
				{
					id: "import-document",
					label: "Import Document...",
					enabled: menuState.hasWorkspace,
					click: () => sendToRenderer("desktop:menu-import-document"),
				},
				{
					id: "open-workspace",
					label: "Open Folder...",
					accelerator: "CmdOrCtrl+Shift+O",
					enabled: menuState.hasWorkspace,
					click: () => sendToRenderer("desktop:menu-show-workspace-switcher"),
				},
				{ type: "separator" },
				{
					id: "sync-workspace",
					label: "Sync Workspace",
					enabled: menuState.hasWorkspace,
					click: () => sendToRenderer("desktop:menu-sync-workspace"),
				},
				{ type: "separator" },
				{ role: "close" },
			],
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: "View",
			submenu: [
				{
					id: "zoom-in",
					label: "Zoom In",
					accelerator: "CmdOrCtrl+=",
					click: () => stepWindowZoom(mainWindow, zoomStep),
				},
				{
					id: "zoom-out",
					label: "Zoom Out",
					accelerator: "CmdOrCtrl+-",
					click: () => stepWindowZoom(mainWindow, -zoomStep),
				},
				{
					id: "reset-zoom",
					label: "Reset Zoom",
					accelerator: "CmdOrCtrl+0",
					click: () => resetWindowZoom(mainWindow),
				},
				...(isDev
					? ([
							{ type: "separator" },
							{ role: "reload" },
							{ role: "forceReload" },
							{ type: "separator" },
							{ role: "toggleDevTools" },
						] satisfies Electron.MenuItemConstructorOptions[])
					: []),
			],
		},
	];

	if (process.platform === "darwin") {
		template.unshift({
			label: app.name,
			submenu: [
				{
					id: "settings",
					label: "Settings...",
					accelerator: "CmdOrCtrl+,",
					click: () => sendToRenderer("desktop:menu-open-settings"),
				},
				{ type: "separator" },
				{
					id: "check-for-updates",
					label: "Check for Updates...",
					click: () => sendToRenderer("desktop:menu-open-settings"),
				},
				{ type: "separator" },
				{ role: "services" },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				{ role: "quit" },
			],
		});
	}

	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function syncUpdateState(nextState: DesktopUpdateState) {
	updateState = nextState;
	buildMenu();
	sendToRenderer("desktop:update-state", updateState);
}

function patchUpdateState(patch: Partial<DesktopUpdateState>) {
	syncUpdateState({
		...updateState,
		...patch,
	});
}

async function checkForUpdates() {
	if (!supportsAutoUpdates) {
		patchUpdateState({
			status: "idle",
			message: "Automatic updates are disabled for this build.",
		});
		return;
	}
	if (
		updateState.status === "checking" ||
		updateState.status === "downloading" ||
		updateState.status === "ready"
	) {
		return;
	}
	patchUpdateState({
		status: "checking",
		progressPercent: null,
		message: null,
	});
	try {
		const autoUpdater = await loadAutoUpdater();
		await autoUpdater.checkForUpdates();
	} catch (error) {
		patchUpdateState({
			status: "error",
			message: error instanceof Error ? error.message : String(error),
			lastCheckedAt: Date.now(),
		});
	}
}

async function configureAutoUpdates() {
	if (!supportsAutoUpdates) return;
	const autoUpdater = await loadAutoUpdater();
	if (updateFeedUrl) {
		autoUpdater.setFeedURL({
			provider: "generic",
			url: updateFeedUrl,
		});
	}
	autoUpdater.autoDownload = true;
	autoUpdater.autoInstallOnAppQuit = true;
	autoUpdater.on("update-available", (info) => {
		patchUpdateState({
			status: "downloading",
			availableVersion: info.version ?? null,
			progressPercent: 0,
			message: "Downloading update...",
			lastCheckedAt: Date.now(),
		});
	});
	autoUpdater.on("update-not-available", () => {
		patchUpdateState({
			status: "up-to-date",
			availableVersion: null,
			progressPercent: null,
			message: "mdly is up to date.",
			lastCheckedAt: Date.now(),
		});
	});
	autoUpdater.on("download-progress", (progress) => {
		patchUpdateState({
			status: "downloading",
			progressPercent: progress.percent,
			message: "Downloading update...",
		});
	});
	autoUpdater.on("update-downloaded", (info) => {
		patchUpdateState({
			status: "ready",
			availableVersion: info.version ?? updateState.availableVersion,
			progressPercent: 100,
			message: "Restart mdly to install the update.",
			lastCheckedAt: Date.now(),
		});
	});
	autoUpdater.on("error", (error) => {
		console.error("Auto-update error", error);
		patchUpdateState({
			status: "error",
			message: error.message,
			lastCheckedAt: Date.now(),
		});
	});

	void checkForUpdates();
	setInterval(() => {
		void checkForUpdates();
	}, updateCheckIntervalMs);
}

async function clearDevHttpCache() {
	if (!isDev) return;
	try {
		await session.defaultSession.clearCache();
	} catch (error) {
		console.warn("Failed to clear development HTTP cache", error);
	}
}

function extensionFromImage(
	bytes: Uint8Array,
	mimeType: string | null,
): string {
	const mime = mimeType?.trim().toLowerCase() ?? "";
	if (mime.includes("png")) return "png";
	if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
	if (mime.includes("webp")) return "webp";
	if (mime.includes("gif")) return "gif";
	if (mime.includes("bmp")) return "bmp";
	if (mime.includes("svg")) return "svg";

	if (
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47
	) {
		return "png";
	}
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "jpg";
	}
	if (Buffer.from(bytes.subarray(0, 6)).toString() === "GIF87a") return "gif";
	if (Buffer.from(bytes.subarray(0, 6)).toString() === "GIF89a") return "gif";
	if (
		bytes.length >= 12 &&
		Buffer.from(bytes.subarray(0, 4)).toString() === "RIFF" &&
		Buffer.from(bytes.subarray(8, 12)).toString() === "WEBP"
	) {
		return "webp";
	}
	if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
	return "png";
}

function fileAssetsDir(filePath: string): string {
	const assetsDir = markdownAssetFolderPath(filePath);
	if (!assetsDir) throw new Error(`Unable to resolve file name: ${filePath}`);
	return assetsDir;
}

async function collectWorkspaceFiles(
	root: string,
	dir: string,
	glob: string,
	out: HtmlAppFileEntry[],
	inheritedRules: IgnoreRule[] = [],
) {
	const rules = await rulesForDir(dir, inheritedRules);
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);
		if (isIgnoredByRules(entryPath, rules, root)) continue;
		const relativePath = path
			.relative(root, entryPath)
			.split(path.sep)
			.join("/");
		if (relativePath === ".hubble" || relativePath.startsWith(".hubble/"))
			continue;
		if (entry.isDirectory()) {
			await collectWorkspaceFiles(root, entryPath, glob, out, rules);
			continue;
		}
		if (!matchesGlob(relativePath, glob)) continue;
		const stat = await fs.stat(entryPath);
		out.push({
			name: entry.name,
			path: relativePath,
			modified_at: Math.floor(stat.mtimeMs / 1000),
			size: stat.size,
		});
	}
}

function matchesGlob(relativePath: string, glob: string): boolean {
	if (glob === "" || glob === "**" || glob === "**/*") return true;
	let source = "";
	for (let index = 0; index < glob.length; index += 1) {
		const char = glob[index];
		const next = glob[index + 1];
		const afterNext = glob[index + 2];
		if (char === "*" && next === "*" && afterNext === "/") {
			source += "(?:.*/)?";
			index += 2;
		} else if (char === "*" && next === "*") {
			source += ".*";
			index += 1;
		} else if (char === "*") {
			source += "[^/]*";
		} else {
			source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
		}
	}
	return new RegExp(`^${source}$`).test(relativePath);
}

async function createWindow() {
	const windowState = await loadWindowState();
	const zoomFactor = loadZoomFactor();
	const window = new BrowserWindow({
		title: appName,
		...(windowState.x !== undefined && windowState.y !== undefined
			? { x: windowState.x, y: windowState.y }
			: {}),
		width: windowState.width,
		height: windowState.height,
		show: false,
		titleBarStyle: "hidden",
		trafficLightPosition: trafficLightPositionForZoom(zoomFactor),
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: path.join(__dirname, "../preload/preload.js"),
			sandbox: false,
		},
	});
	mainWindow = window;
	// Trace memory/crash telemetry to userData/logs so a background OOM leaves
	// a diagnosable record on disk (see crashTrace.ts).
	startCrashTrace(window);
	// macOS hides Writing Tools/AutoFill/Services from Electron's context menu
	// unless a menu is popped up with the originating frame attached.
	if (process.platform === "darwin") {
		const editMenu = Menu.buildFromTemplate([{ role: "editMenu" }]);
		window.webContents.on("context-menu", (_event, params) => {
			if (params.isEditable) {
				editMenu.popup({ window, frame: params.frame });
			}
		});
	}
	if (windowState.isFullScreen) {
		window.setFullScreen(true);
	} else if (windowState.isMaximized) {
		window.maximize();
	}
	// Apply persisted zoom while hidden so the first visible paint is already scaled.
	window.webContents.once("did-finish-load", async () => {
		window.webContents.setZoomFactor(zoomFactor);
		await setTrafficLightInset(window, zoomFactor);
		if (window.isDestroyed()) return;
		window.show();
	});
	window.webContents.on(
		"did-fail-load",
		(_event, errorCode, errorDescription, validatedUrl) => {
			console.error("Renderer failed to load", {
				errorCode,
				errorDescription,
				validatedUrl,
			});
		},
	);
	// Recover from renderer crashes (e.g. V8 SIGTRAP) by reloading instead of
	// leaving a permanently blank window. Back off if the renderer crash-loops.
	let consecutiveRendererCrashes = 0;
	let lastRendererCrashAt = 0;
	const rendererCrashWindowMs = 5000;
	const maxConsecutiveRendererCrashes = 3;
	window.webContents.on("render-process-gone", (_event, details) => {
		console.error("Renderer process gone", details);
		if (details.reason === "clean-exit" || window.isDestroyed()) return;
		const now = Date.now();
		consecutiveRendererCrashes =
			now - lastRendererCrashAt < rendererCrashWindowMs
				? consecutiveRendererCrashes + 1
				: 1;
		lastRendererCrashAt = now;
		if (consecutiveRendererCrashes > maxConsecutiveRendererCrashes) {
			console.error("Renderer crashed repeatedly; leaving window as-is", {
				consecutiveRendererCrashes,
			});
			return;
		}
		console.error("Reloading renderer after crash", {
			attempt: consecutiveRendererCrashes,
		});
		window.webContents.reload();
	});
	window.webContents.on("unresponsive", () => {
		console.error("Renderer became unresponsive");
	});
	window.webContents.on(
		"console-message",
		(_event, level, message, line, sourceId) => {
			if (level < 2) return;
			console.error("Renderer console message", {
				level,
				message,
				line,
				sourceId,
			});
		},
	);

	window.on("focus", () => sendToRenderer("desktop:window-focus"));
	window.on("enter-full-screen", () =>
		sendToRenderer("desktop:fullscreen-change", true),
	);
	window.on("leave-full-screen", () =>
		sendToRenderer("desktop:fullscreen-change", false),
	);
	window.on("resize", () => queueSaveWindowState(window));
	window.on("move", () => queueSaveWindowState(window));
	window.on("close", () => {
		if (saveWindowStateTimer) {
			clearTimeout(saveWindowStateTimer);
			saveWindowStateTimer = null;
		}
		saveWindowState(window);
	});
	window.on("closed", () => {
		if (mainWindow === window) mainWindow = null;
	});

	if (isDev && process.env.ELECTRON_RENDERER_URL) {
		await window.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		await window.loadURL(rendererAppUrl);
	}
}

function registerIpc() {
	// Diagnostic-only: renderer storm detector forwards abnormal file-list
	// store-write bursts (with the offending stack) into the crash-trace log.
	// Fire-and-forget so it never blocks the renderer mid-storm; recording
	// respects the crash-trace kill switch inside recordCrashTraceEvent.
	ipcMain.on("desktop:renderer-storm", (_event, payload: unknown) => {
		recordCrashTraceEvent(
			"renderer-storm",
			payload && typeof payload === "object"
				? (payload as Record<string, unknown>)
				: { payload },
		);
	});

	ipcMain.handle(
		"desktop:list-directory",
		async (
			_event,
			{ path: dirPath, options }: { path: string; options?: unknown },
		) => {
			const root = assertGrantedRoot(dirPath);
			const stat = await fs.stat(root);
			if (!stat.isDirectory()) throw new Error(`Not a directory: ${dirPath}`);
			const listing: DirectoryListing = { files: [], folders: [] };
			await collectDocumentFiles(root, listing, {
				includeIgnoredWorkspaceFiles:
					typeof options === "object" &&
					options !== null &&
					"includeIgnoredWorkspaceFiles" in options &&
					options.includeIgnoredWorkspaceFiles === true,
			});
			return listing;
		},
	);

	ipcMain.handle(
		"desktop:scan-front-matter-tags",
		async (_event, { paths }: { paths: string[] }) => {
			// Same access boundary as reading a file directly -- the scan can only
			// touch paths the renderer was already granted.
			const granted = (Array.isArray(paths) ? paths : [])
				.map((candidate) => {
					try {
						return assertGranted(String(candidate));
					} catch {
						return null;
					}
				})
				.filter((path): path is string => path !== null);
			return await scanFrontMatterTags(granted);
		},
	);

	ipcMain.handle(
		"desktop:html-app-list-files",
		async (_event, { workspacePath, glob }) => {
			const root = assertGrantedRoot(workspacePath);
			const stat = await fs.stat(root);
			if (!stat.isDirectory())
				throw new Error(`Not a directory: ${workspacePath}`);
			const files: HtmlAppFileEntry[] = [];
			await collectWorkspaceFiles(root, root, String(glob ?? "**/*"), files);
			return files.sort((a, b) => a.path.localeCompare(b.path));
		},
	);

	ipcMain.handle(
		"desktop:read-workspace-config",
		async (_event, { workspacePath }) => {
			try {
				return parseWorkspaceConfig(
					await fs.readFile(workspaceConfigPath(workspacePath), "utf8"),
				);
			} catch (err) {
				if (
					err &&
					typeof err === "object" &&
					"code" in err &&
					err.code === "ENOENT"
				) {
					return emptyWorkspaceConfig();
				}
				throw err;
			}
		},
	);

	ipcMain.handle(
		"desktop:write-workspace-config",
		async (_event, { workspacePath, config }) => {
			const configPath = workspaceConfigPath(workspacePath);
			await fs.mkdir(path.dirname(configPath), { recursive: true });
			await fs.writeFile(
				configPath,
				`${JSON.stringify(normalizeWorkspaceConfig(config), null, 2)}\n`,
			);
			grantFile(configPath);
		},
	);

	ipcMain.handle(
		"desktop:read-file-text",
		async (_event, { path: filePath }) => {
			const resolved = assertGranted(filePath);
			return await fs.readFile(resolved, "utf8");
		},
	);

	ipcMain.handle(
		"desktop:write-file-text",
		async (_event, { path: filePath, content, historyCause }) => {
			const resolved = assertGranted(filePath);
			await fs.mkdir(path.dirname(resolved), { recursive: true });
			const text = String(content);
			await fs.writeFile(resolved, text);
			// Never affects the write above (R29) — recordInAppWriteHistory
			// swallows its own errors.
			if (isInAppHistoryCause(historyCause)) {
				await recordInAppWriteHistory({
					absoluteFilePath: resolved,
					content: text,
					grantedRoots,
					actorId: await getActorId(),
					historyCause,
					echoTracker: historyEchoTracker,
				});
			}
		},
	);

	// Read-only history lookups (R19): thin wrappers over already-tested
	// `@mdly/doc-history` functions. Never call a write path (recordRevision /
	// appendLogEntry) from here.
	ipcMain.handle(
		"desktop:get-revision-history",
		async (_event, { path: filePath }) => {
			const resolved = assertGranted(filePath);
			const workspaceRoot = resolveHistoryWorkspaceRoot(resolved, grantedRoots);
			if (!workspaceRoot) return [];
			const relativePath = toWorkspaceRelativePath(workspaceRoot, resolved);
			return await getHistoryStoreForWorkspace(
				workspaceRoot,
			).getRevisionHistory(relativePath);
		},
	);

	ipcMain.handle(
		"desktop:read-revision-content",
		async (_event, { path: filePath, revisionId }) => {
			const resolved = assertGranted(filePath);
			const workspaceRoot = resolveHistoryWorkspaceRoot(resolved, grantedRoots);
			if (!workspaceRoot) return { status: "not-found" as const };
			const relativePath = toWorkspaceRelativePath(workspaceRoot, resolved);
			const result = await getHistoryStoreForWorkspace(
				workspaceRoot,
			).readRevisionContent(relativePath, String(revisionId));
			if (result.status !== "ok") return result;
			return {
				status: "ok" as const,
				content: new TextDecoder().decode(result.bytes),
			};
		},
	);

	// Local document comments (desktop wiring for @mdly/doc-comments, Slice 3).
	// The main process has no live-editor-draft concept, so anchor resolution
	// happens client-side in the kit -- these handlers only persist/read the
	// append-only comment event log. `desktop:comment-list-threads` folds both
	// `docId` resolution and the current user's author identity into its
	// response rather than adding two more channels -- `CommentOptions.docId`/
	// `.currentAuthor` are both needed synchronously by the renderer before it
	// can render `<EditorView commentOptions>` at all.
	ipcMain.handle(
		"desktop:comment-list-threads",
		async (_event, { path: filePath }) => {
			const resolved = assertGranted(filePath);
			const { docId, threads } = await listCommentThreadsForPath(
				resolved,
				grantedRoots,
			);
			return {
				docId,
				threads,
				currentAuthor: { kind: "human" as const, id: await getActorId() },
			};
		},
	);

	ipcMain.handle(
		"desktop:comment-open-thread",
		async (_event, { path: filePath, anchor, text }) => {
			const resolved = assertGranted(filePath);
			await openCommentThreadForPath({
				absoluteFilePath: resolved,
				grantedRoots,
				author: { kind: "human", id: await getActorId() },
				anchor,
				text: String(text),
			});
		},
	);

	ipcMain.handle(
		"desktop:comment-reply",
		async (_event, { path: filePath, threadId, text }) => {
			const resolved = assertGranted(filePath);
			await replyToCommentThreadForPath({
				absoluteFilePath: resolved,
				grantedRoots,
				author: { kind: "human", id: await getActorId() },
				threadId: String(threadId),
				text: String(text),
			});
		},
	);

	ipcMain.handle(
		"desktop:comment-resolve",
		async (_event, { path: filePath, threadId }) => {
			const resolved = assertGranted(filePath);
			await resolveCommentThreadForPath({
				absoluteFilePath: resolved,
				grantedRoots,
				author: { kind: "human", id: await getActorId() },
				threadId: String(threadId),
			});
		},
	);

	ipcMain.handle(
		"desktop:comment-reopen",
		async (_event, { path: filePath, threadId }) => {
			const resolved = assertGranted(filePath);
			await reopenCommentThreadForPath({
				absoluteFilePath: resolved,
				grantedRoots,
				author: { kind: "human", id: await getActorId() },
				threadId: String(threadId),
			});
		},
	);

	ipcMain.handle(
		"desktop:rename-file",
		async (_event, { fromPath, toPath }) => {
			const from = assertGranted(fromPath);
			const to = resolvePath(toPath);
			assertGranted(path.dirname(to));
			await fs.mkdir(path.dirname(to), { recursive: true });
			await fs.rename(from, to);
			grantFileWithParent(to);
			// Never affects the rename above (R31) — recordRenameHistory
			// swallows its own errors.
			await recordRenameHistory({
				fromAbsolutePath: from,
				toAbsolutePath: to,
				grantedRoots,
			});
		},
	);

	ipcMain.handle(
		"desktop:rename-symlink-target",
		async (_event, { linkPath, nextName }) => {
			const link = assertGranted(linkPath);
			const linkStat = await fs.lstat(link);
			if (!linkStat.isSymbolicLink())
				throw new Error(`Not a symbolic link: ${linkPath}`);
			const rawTarget = await fs.readlink(link);
			const target = await fs.realpath(link);
			const targetDir = path.dirname(target);
			const normalizedName = path.normalize(String(nextName));
			if (
				path.isAbsolute(normalizedName) ||
				normalizedName === ".." ||
				normalizedName.startsWith(`..${path.sep}`)
			) {
				throw new Error(`Unsafe symlink target rename: ${nextName}`);
			}
			const nextTarget = path.join(targetDir, normalizedName);
			if (path.resolve(nextTarget) === path.resolve(target)) return;
			if (await pathExists(nextTarget))
				throw new Error(`Target already exists: ${nextTarget}`);
			await fs.mkdir(path.dirname(nextTarget), { recursive: true });
			await fs.rename(target, nextTarget);
			const nextRawTarget = path.isAbsolute(rawTarget)
				? nextTarget
				: path.relative(path.dirname(link), nextTarget);
			await fs.unlink(link);
			await fs.symlink(nextRawTarget, link);
		},
	);

	ipcMain.handle("desktop:path-exists", async (_event, { path: filePath }) =>
		pathExists(assertGranted(filePath)),
	);

	ipcMain.handle(
		"desktop:persist-pasted-image",
		async (_event, { filePath, bytes, mimeType }) => {
			const resolvedFilePath = assertGranted(filePath);
			if (!Array.isArray(bytes) || bytes.length === 0) {
				throw new Error("Clipboard image bytes are empty");
			}
			const imageBytes = Uint8Array.from(bytes);
			const assetsDir = fileAssetsDir(resolvedFilePath);
			await fs.mkdir(assetsDir, { recursive: true });
			grantRoot(assetsDir);

			const hash = createHash("sha256").update(imageBytes).digest("hex");
			const shortHash = hash.slice(0, 12);
			const ext = extensionFromImage(imageBytes, mimeType);
			let imagePath = path.join(assetsDir, `${shortHash}.${ext}`);
			let deduped = false;

			if (await pathExistsAsFile(imagePath)) {
				const existing = await fs.readFile(imagePath);
				if (Buffer.compare(existing, imageBytes) === 0) {
					deduped = true;
				} else {
					imagePath = path.join(assetsDir, `${hash}.${ext}`);
					if (await pathExistsAsFile(imagePath)) {
						const existingFull = await fs.readFile(imagePath);
						if (Buffer.compare(existingFull, imageBytes) === 0) {
							deduped = true;
						} else {
							throw new Error(
								`Hash collision while saving image at ${imagePath}`,
							);
						}
					}
				}
			}

			if (!deduped && !(await pathExistsAsFile(imagePath))) {
				await fs.writeFile(imagePath, imageBytes);
			}

			grantFile(imagePath);
			return {
				relativeMarkdownPath: path
					.relative(path.dirname(resolvedFilePath), imagePath)
					.split(path.sep)
					.join("/"),
				deduped,
			};
		},
	);

	ipcMain.handle(
		"desktop:delete-file",
		async (_event, { path: filePath, options }) => {
			const resolved = assertGranted(filePath);
			await fs.rm(resolved, {
				recursive: options?.recursive === true,
			});
			// Never affects the delete above (R33) — recordDeleteHistory swallows
			// its own errors. Breaks the deleted path's document-id binding so a
			// later unrelated file written to this same path doesn't silently
			// continue the deleted document's revision log.
			await recordDeleteHistory({
				absoluteFilePath: resolved,
				grantedRoots,
			});
		},
	);

	ipcMain.handle(
		"desktop:read-binary-file",
		async (_event, { path: filePath }) =>
			Array.from(await fs.readFile(assertGranted(filePath))),
	);

	ipcMain.handle(
		"desktop:write-binary-file",
		async (_event, { path: filePath, bytes }) => {
			if (!Array.isArray(bytes)) throw new Error("Bytes must be an array");
			await fs.writeFile(assertGranted(filePath), Uint8Array.from(bytes));
		},
	);

	ipcMain.handle("desktop:open-file-picker", async (_event, options = {}) => {
		const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
			properties: ["openFile"],
			defaultPath:
				typeof options.defaultPath === "string"
					? options.defaultPath
					: undefined,
			title: "Open Markdown file",
			filters: Array.isArray(options.filters)
				? options.filters
				: [
						{
							name: "Documents",
							extensions: ["md", "markdown", "mdown", "html"],
						},
						{ name: "Text", extensions: ["txt", "text"] },
					],
		});
		const selected = result.filePaths[0] ?? null;
		if (selected) grantFileWithParent(selected);
		return selected;
	});

	ipcMain.handle("desktop:open-folder-picker", async () => {
		const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
			properties: ["openDirectory"],
			title: "Open Folder",
		});
		const selected = result.filePaths[0] ?? null;
		if (selected) grantRoot(selected);
		return selected;
	});

	ipcMain.handle("desktop:create-folder-picker", async () => {
		const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
			title: "New Folder",
			nameFieldLabel: "Folder name:",
			buttonLabel: "Create",
			properties: ["createDirectory"],
		});
		if (result.canceled || !result.filePath) return null;
		const folderPath = result.filePath;
		await fs.mkdir(folderPath, { recursive: true });
		grantRoot(folderPath);
		return folderPath;
	});

	ipcMain.handle(
		"desktop:save-markdown-file-picker",
		async (_event, options = {}) => {
			const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
				defaultPath:
					typeof options.defaultPath === "string"
						? options.defaultPath
						: undefined,
				title: "New Markdown file",
				filters: [{ name: "Markdown", extensions: ["md"] }],
			});
			if (result.canceled || !result.filePath) return null;
			const selected = withMarkdownExtension(result.filePath);
			grantFileWithParent(selected);
			return selected;
		},
	);

	ipcMain.handle(
		"desktop:watch-path",
		async (_event, { watchId, path: watchPath }) => {
			const id = String(watchId);
			const resolved = assertGranted(watchPath);
			const emit = (changedPath: string) => {
				sendToRenderer(`desktop:watch-path:${watchId}`, [
					path.resolve(changedPath),
				]);
			};

			const createWatcher = async () => {
				const watcher = chokidar.watch(resolved, {
					ignoreInitial: true,
					// Only the active file uses this watcher. The sidebar refreshes from
					// snapshots so large workspaces do not create one watcher per folder.
					depth: 0,
				});
				const emitFile = (changedPath: string) => {
					if (hasDocumentExtension(changedPath)) {
						emit(changedPath);
					}
				};
				// Markdown adds/changes additionally cut external-write history
				// (R13). `emit()` (the existing UI-refresh signal) always runs
				// first and is never delayed/duplicated/swallowed by this (R30) —
				// history recording is fire-and-forget and swallows its own
				// errors. `unlink` intentionally stays on the plain `emitFile`:
				// an outside tool's atomic temp-file-then-rename save reports as
				// unlink immediately followed by add, and recording history off
				// the transient unlink would read a momentarily-missing file and
				// could misfire (R35) — recordExternalWriteHistory itself also
				// no-ops when the read fails, as defense in depth.
				const emitFileAndRecordHistory = (changedPath: string) => {
					emitFile(changedPath);
					if (hasMarkdownExtension(changedPath)) {
						void recordExternalWriteHistory({
							absoluteFilePath: path.resolve(changedPath),
							grantedRoots,
							echoTracker: historyEchoTracker,
						});
					}
				};
				watcher.on("add", emitFileAndRecordHistory);
				watcher.on("change", emitFileAndRecordHistory);
				watcher.on("unlink", emitFile);
				watcher.on("addDir", emit);
				watcher.on("unlinkDir", emit);
				watcher.on("error", (error) => {
					console.error("File watcher failed:", error);
				});
				return watcher;
			};

			watchers.set(id, await createWatcher());
		},
	);

	ipcMain.handle("desktop:unwatch-path", async (_event, { watchId }) => {
		const watcher = watchers.get(String(watchId));
		if (watcher) {
			watchers.delete(String(watchId));
			await watcher.close();
		}
	});

	ipcMain.handle("desktop:open-external-url", async (_event, { url }) => {
		if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
			throw new Error("Only http(s) external URLs are allowed");
		}
		await shell.openExternal(url);
	});

	ipcMain.handle("desktop:reveal-file", (_event, { path: filePath }) => {
		shell.showItemInFolder(assertGranted(filePath));
	});

	ipcMain.handle("desktop:resolve-path", (_event, { path }) =>
		resolvePath(path),
	);

	ipcMain.handle("desktop:real-path", async (_event, { path: filePath }) =>
		fs.realpath(assertGranted(filePath)),
	);

	ipcMain.handle("desktop:get-launch-file-path", () => {
		const pathToOpen = pendingOpenPath;
		pendingOpenPath = null;
		return pathToOpen;
	});

	ipcMain.handle(
		"desktop:get-launch-workspace-path",
		() => launchWorkspacePath,
	);

	ipcMain.handle("desktop:get-update-state", () => updateState);

	ipcMain.handle(
		"desktop:get-fullscreen",
		() => mainWindow?.isFullScreen() ?? false,
	);

	ipcMain.handle(
		"desktop:notion-connection-status",
		(_event, { account } = {}) => getNotionConnectionStatus(account),
	);

	ipcMain.handle("desktop:notion-set-account", (_event, { account }) =>
		setNotionAccount(account),
	);

	ipcMain.handle("desktop:notion-search", (_event, { query, account }) =>
		searchNotion(query, account),
	);

	ipcMain.handle(
		"desktop:notion-page-markdown",
		(_event, { pageId, account }) => getNotionPageMarkdown(pageId, account),
	);

	ipcMain.handle(
		"desktop:notion-update-page-markdown",
		(_event, { pageId, markdown, account, options }) =>
			updateNotionPageMarkdown(pageId, markdown, account, options),
	);

	ipcMain.handle("desktop:notion-query-database", (_event, input) =>
		queryNotionDatabase(input),
	);

	ipcMain.handle("desktop:doc-import-convert", (_event, { filePath }) =>
		convertDocFile(filePath),
	);

	ipcMain.handle("desktop:doc-import-convert-url", async (_event, { url }) => {
		const acquired = await acquireDocSource(url);
		grantFileWithParent(acquired.path);
		const result = await convertDocFile(acquired.path, {
			title: acquired.title,
		});
		return { ...result, origin: "url", url, path: acquired.path };
	});

	ipcMain.handle(
		"desktop:doc-import-retain-source",
		async (_event, { sourcePath, markdownFilePath, keep }) => {
			if (keep) {
				const assetsDir = markdownAssetFolderPath(
					assertGranted(markdownFilePath),
				);
				if (!assetsDir) throw new Error("Unable to resolve asset folder");
				await fs.mkdir(assetsDir, { recursive: true });
				const sourceName = path.basename(sourcePath);
				const target = path.join(assetsDir, sourceName);
				await fs.copyFile(assertGranted(sourcePath), target);
				grantFile(target);
				return target;
			}
			return null;
		},
	);

	ipcMain.handle("desktop:doc-import-check-converter", () =>
		checkConverterStatus(),
	);

	ipcMain.handle("desktop:check-for-updates", async () => {
		await checkForUpdates();
	});

	ipcMain.handle("desktop:install-update", async () => {
		if (updateState.status !== "ready") {
			throw new Error("No downloaded update is ready to install.");
		}
		const autoUpdater = await loadAutoUpdater();
		autoUpdater.quitAndInstall(false, true);
	});

	ipcMain.handle("desktop:set-menu-state", (_event, state: MenuState) => {
		menuState = { hasWorkspace: state.hasWorkspace === true };
		buildMenu();
	});
}

protocol.registerSchemesAsPrivileged([
	{
		scheme: "hubble-asset",
		privileges: {
			secure: true,
			supportFetchAPI: true,
			corsEnabled: true,
			standard: true,
		},
	},
	// The renderer's home origin. Packaged mdly serves the UI from this
	// privileged scheme instead of file:// so the page gets a real tuple origin
	// (app://mdly) and a secure context — file:// reports an opaque "null"
	// origin, which the WebMCP relay rejects (see docs/plans/local-doc-comments.md,
	// slice 3).
	{
		scheme: "app",
		privileges: {
			secure: true,
			supportFetchAPI: true,
			corsEnabled: true,
			standard: true,
		},
	},
]);

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
	app.quit();
} else {
	app.on("second-instance", (_event, argv) => {
		const openPath = firstExistingFileArg(argv.slice(1));
		if (!openPath) return;
		pendingOpenPath = openPath;
		if (mainWindow) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.focus();
			sendToRenderer("desktop:open-file", openPath);
		}
	});

	app.on("open-file", (event, filePath) => {
		event.preventDefault();
		const resolved = resolvePath(filePath);
		grantFileWithParent(resolved);
		pendingOpenPath = resolved;
		sendToRenderer("desktop:open-file", resolved);
	});

	app.whenReady().then(async () => {
		// Fire-and-forget: warms the login-shell PATH (nvm/rvm/homebrew dirs a
		// GUI-launched app doesn't inherit) before the user opens an import
		// dialog. Slow (~1-8s on a heavy shell profile), so never awaited here;
		// anydoc/ntn-acct callers await the same cached promise for correctness.
		void ensureLoginShellPathMerged();
		await clearDevHttpCache();
		await loadGrants();
		if (launchWorkspacePath) grantRoot(launchWorkspacePath);
		await saveGrants();
		protocol.handle("hubble-asset", (request) => {
			const url = new URL(request.url);
			const filePath = assertGranted(assetPathFromUrl(url));
			// HTML apps use this protocol as their base URL, so relative
			// scripts, stylesheets, images, and fetches resolve to granted files.
			// Disable caching because these files are edited directly in workspaces.
			return responseForAsset(filePath);
		});
		// The renderer's own scheme. Unlike hubble-asset, this serves fixed app
		// files from the packaged renderer dir — no grant check, but never outside
		// that dir. Content-hashed assets are immutable, so they cache long;
		// index.html and anything else revalidates on every load.
		protocol.handle("app", (request) => {
			const url = new URL(request.url);
			const relativePath = decodeURIComponent(
				url.pathname === "/" ? "/index.html" : url.pathname,
			).replace(/^\/+/, "");
			const filePath = path.join(rendererDir, relativePath);
			if (
				!filePath.startsWith(`${rendererDir}${path.sep}`) &&
				filePath !== rendererDir
			) {
				return new Response("Not found", { status: 404 });
			}
			try {
				const body = fsSync.readFileSync(filePath);
				const isHashedAsset = /\/assets\/.+\.(?:js|css|ttf|woff2?|png|svg|mp4)$/.test(
					url.pathname,
				);
				return new Response(body, {
					headers: {
						"content-type": assetContentType(filePath),
						"cache-control": isHashedAsset
							? "public, max-age=31536000, immutable"
							: "no-cache",
					},
				});
			} catch {
				return new Response("Not found", { status: 404 });
			}
		});
		registerIpc();
		buildMenu();
		void configureAutoUpdates();
		await createWindow();
	});

	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") app.quit();
	});

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			void createWindow();
		}
	});
}
