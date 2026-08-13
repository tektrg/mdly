import os from "node:os";
import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "../src/desktopApi/types";

function subscribe<T extends unknown[]>(
	channel: string,
	callback: (...args: T) => void,
) {
	const listener = (_event: Electron.IpcRendererEvent, ...args: T) =>
		callback(...args);
	ipcRenderer.on(channel, listener);
	return () => ipcRenderer.removeListener(channel, listener);
}

let nextWatchId = 0;

const desktopApi = {
	platform: process.platform,
	homeDir: os.homedir(),
	listDirectory: (path, options) =>
		ipcRenderer.invoke("desktop:list-directory", { path, options }),
	listHtmlAppFiles: (workspacePath, glob) =>
		ipcRenderer.invoke("desktop:html-app-list-files", { workspacePath, glob }),
	scanFrontMatterTags: (paths) =>
		ipcRenderer.invoke("desktop:scan-front-matter-tags", { paths }),
	readWorkspaceConfig: (workspacePath) =>
		ipcRenderer.invoke("desktop:read-workspace-config", { workspacePath }),
	writeWorkspaceConfig: (workspacePath, config) =>
		ipcRenderer.invoke("desktop:write-workspace-config", {
			workspacePath,
			config,
		}),
	readFileText: (path) =>
		ipcRenderer.invoke("desktop:read-file-text", { path }),
	writeFileText: (path, content) =>
		ipcRenderer.invoke("desktop:write-file-text", { path, content }),
	renameFile: (fromPath, toPath) =>
		ipcRenderer.invoke("desktop:rename-file", { fromPath, toPath }),
	renameSymlinkTarget: (linkPath, nextName) =>
		ipcRenderer.invoke("desktop:rename-symlink-target", {
			linkPath,
			nextName,
		}),
	pathExists: (path) => ipcRenderer.invoke("desktop:path-exists", { path }),
	persistPastedImage: (input) =>
		ipcRenderer.invoke("desktop:persist-pasted-image", input),
	deleteFile: (path, options) =>
		ipcRenderer.invoke("desktop:delete-file", { path, options }),
	readBinaryFile: (path) =>
		ipcRenderer.invoke("desktop:read-binary-file", { path }),
	writeBinaryFile: (path, bytes) =>
		ipcRenderer.invoke("desktop:write-binary-file", { path, bytes }),
	openFilePicker: (options) =>
		ipcRenderer.invoke("desktop:open-file-picker", options),
	openFolderPicker: () => ipcRenderer.invoke("desktop:open-folder-picker"),
	createFolderPicker: () => ipcRenderer.invoke("desktop:create-folder-picker"),
	saveMarkdownFilePicker: (options) =>
		ipcRenderer.invoke("desktop:save-markdown-file-picker", options),
	watchPath: async (path, options, callback) => {
		const watchId = String(++nextWatchId);
		const unsubscribeEvents = subscribe(
			`desktop:watch-path:${watchId}`,
			(paths: string[]) => callback(paths),
		);
		await ipcRenderer.invoke("desktop:watch-path", { watchId, path, options });
		return () => {
			unsubscribeEvents();
			void ipcRenderer.invoke("desktop:unwatch-path", { watchId });
		};
	},
	openExternalUrl: (url) =>
		ipcRenderer.invoke("desktop:open-external-url", { url }),
	revealFile: (path) => ipcRenderer.invoke("desktop:reveal-file", { path }),
	resolvePath: (path) => ipcRenderer.invoke("desktop:resolve-path", { path }),
	realPath: (path) => ipcRenderer.invoke("desktop:real-path", { path }),
	toAssetUrl: (path) =>
		`hubble-asset://local/?path=${encodeURIComponent(path)}`,
	getLaunchFilePath: () => ipcRenderer.invoke("desktop:get-launch-file-path"),
	getLaunchWorkspacePath: () =>
		ipcRenderer.invoke("desktop:get-launch-workspace-path"),
	setMenuState: (state) => ipcRenderer.invoke("desktop:set-menu-state", state),
	getUpdateState: () => ipcRenderer.invoke("desktop:get-update-state"),
	getFullScreen: () => ipcRenderer.invoke("desktop:get-fullscreen"),
	getNotionConnectionStatus: (account) =>
		ipcRenderer.invoke("desktop:notion-connection-status", { account }),
	setNotionAccount: (account) =>
		ipcRenderer.invoke("desktop:notion-set-account", { account }),
	searchNotion: (query, account) =>
		ipcRenderer.invoke("desktop:notion-search", { query, account }),
	getNotionPageMarkdown: (pageId, account) =>
		ipcRenderer.invoke("desktop:notion-page-markdown", { pageId, account }),
	updateNotionPageMarkdown: (pageId, markdown, account, options) =>
		ipcRenderer.invoke("desktop:notion-update-page-markdown", {
			pageId,
			markdown,
			account,
			options,
		}),
	queryNotionDatabase: (input) =>
		ipcRenderer.invoke("desktop:notion-query-database", input),
		docImportConvert: (filePath) =>
			ipcRenderer.invoke("desktop:doc-import-convert", { filePath }),
		docImportConvertUrl: (url) =>
			ipcRenderer.invoke("desktop:doc-import-convert-url", { url }),
		docImportRetainSource: (sourcePath, markdownFilePath, keep) =>
			ipcRenderer.invoke("desktop:doc-import-retain-source", { sourcePath, markdownFilePath, keep }),
		docImportCheckConverter: () =>
			ipcRenderer.invoke("desktop:doc-import-check-converter"),
	checkForUpdates: () => ipcRenderer.invoke("desktop:check-for-updates"),
	installUpdate: () => ipcRenderer.invoke("desktop:install-update"),
	onOpenFile: (callback) =>
		subscribe("desktop:open-file", (path: string) => callback(path)),
	onUpdateStateChange: (callback) =>
		subscribe("desktop:update-state", callback),
	onMenuCreateMarkdownFile: (callback) =>
		subscribe("desktop:menu-create-markdown-file", callback),
	onMenuOpenFile: (callback) => subscribe("desktop:menu-open-file", callback),
	onMenuOpenFolder: (callback) =>
		subscribe("desktop:menu-open-folder", callback),
	onMenuOpenSettings: (callback) =>
		subscribe("desktop:menu-open-settings", callback),
	onMenuShowWorkspaceSwitcher: (callback) =>
		subscribe("desktop:menu-show-workspace-switcher", callback),
	onMenuSyncWorkspace: (callback) =>
		subscribe("desktop:menu-sync-workspace", callback),
	onWindowFocus: (callback) => subscribe("desktop:window-focus", callback),
	onFullScreenChange: (callback) =>
		subscribe("desktop:fullscreen-change", (isFullScreen: boolean) =>
			callback(isFullScreen),
		),
} satisfies DesktopApi;

contextBridge.exposeInMainWorld("desktopApi", desktopApi);

// Diagnostic-only bridge for the renderer storm detector (background OOM crash
// investigation). Gated by the same kill switch as the crash tracer: when
// disabled, the bridge is absent and the renderer detector no-ops entirely.
if (process.env.HUBBLE_DESKTOP_DISABLE_CRASH_TRACE !== "1") {
	contextBridge.exposeInMainWorld("hubbleDiagnostics", {
		reportStorm: (payload: Record<string, unknown>) =>
			ipcRenderer.send("desktop:renderer-storm", payload),
	});
}
