import type { RemoteFile, SyncBackend } from "@hubble.md/sync";
import {
	createCloudflareBackend,
	listWorkspaces,
} from "@mdly/cloudflare-client";
import { stripMarkdownExtension } from "@mdly/workspace-kit";
import { describeApiError, isUnauthorizedError } from "../connection/apiError";
import { ensureDeviceId } from "../connection/deviceId";
import { WORKER_BASE_URL } from "../connection/workerUrl";
import { latest } from "../lib/latest";
import {
	type AssetEntry,
	appStore,
	type FileEntry,
	resetState,
	type ViewerState,
	viewerStore,
	workspaceStore,
} from "./state";
import {
	isSidecarRow,
	sidecarsChanged,
	type SidecarEntry,
	toSidecarMap,
} from "./sidecars";

type Ctx = {
	backend: SyncBackend;
	workspaceId: string;
	deviceId: string;
};

let ctx: Ctx | null = null;

function createCtx(workspaceId: string): Ctx {
	return {
		backend: createCloudflareBackend({
			baseUrl: WORKER_BASE_URL,
			auth: { kind: "cookie" },
		}),
		workspaceId,
		deviceId: ensureDeviceId(),
	};
}

export function initActions(workspaceId: string): void {
	ctx = createCtx(workspaceId);
}

export function teardownActions(): void {
	ctx = null;
	resetState();
}

function requireCtx(): Ctx {
	if (!ctx) throw new Error("actions not initialized");
	return ctx;
}

export function getActionCtx(): Ctx | null {
	return ctx;
}

type WorkspaceSnapshot = {
	workspace: { id: string; name: string };
	files: FileEntry[];
	sidecars: Record<string, SidecarEntry>;
	assets: AssetEntry[];
	currentFile: RemoteFile | null;
};

async function fetchWorkspaceSnapshot(
	workspaceId: string,
	selectedPath: string | null,
): Promise<WorkspaceSnapshot> {
	const workspacesPromise = listWorkspaces({
		baseUrl: WORKER_BASE_URL,
		auth: { kind: "cookie" },
	});
	const backend = createCloudflareBackend({
		baseUrl: WORKER_BASE_URL,
		auth: { kind: "cookie" },
	});
	const filesPromise = backend.getFiles(workspaceId);
	const assetsPromise = backend.getAssets(workspaceId);
	// All three requests race together in one Promise.all (rather than
	// awaiting workspacesPromise separately afterward) so that a total
	// network failure — every request rejecting at once, R39 — can never
	// leave workspacesPromise's own rejection unobserved: if files/assets
	// threw first and execution moved on before `await workspacesPromise` was
	// reached, that promise's rejection would surface as a genuine unhandled
	// promise rejection instead of the clean, caught "can't reach the
	// server" error this function is supposed to produce.
	const [files, assets, workspaces] = await Promise.all([
		filesPromise,
		assetsPromise,
		workspacesPromise,
	]);
	const workspace =
		workspaces.find((candidate) => candidate.workspaceId === workspaceId) ??
		null;
	if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);

	const visible: FileEntry[] = files
		.filter((f) => !isSidecarRow(f.path))
		.map((f) => ({
			path: f.path,
			contentHash: f.contentHash,
			updatedAt: f.updatedAt,
			deleted: f.deleted,
		}));
	const assetEntries: AssetEntry[] = assets.map((asset) => ({
		path: asset.path,
		storageId: asset.storageId,
		contentHash: asset.contentHash,
		updatedAt: asset.updatedAt,
		deleted: asset.deleted,
	}));
	const currentFile =
		selectedPath === null
			? null
			: (files.find((file) => file.path === selectedPath) ?? null);

	return {
		workspace: { id: workspace.workspaceId, name: workspace.name },
		files: visible,
		sidecars: toSidecarMap(files),
		assets: assetEntries,
		currentFile,
	};
}

/**
 * Result kind lets callers (AppShell) distinguish "the session expired" from
 * any other failure — a 401 should bounce the user back to the login screen
 * instead of showing a dead-end "Reload" button that will just 401 again.
 */
export type LoadWorkspaceSnapshotResult = "loaded" | "unauthorized" | "failed";

export const loadWorkspaceSnapshot = latest(
	async (
		{ isStale },
		workspaceId: string,
		selectedPath: string | null = null,
	): Promise<LoadWorkspaceSnapshotResult> => {
		const previousSnapshot = workspaceStore.get().snapshot;
		if (!previousSnapshot) {
			workspaceStore.set((state) => ({
				...state,
				status: "loading",
				error: null,
			}));
		}
		try {
			const snapshot = await fetchWorkspaceSnapshot(workspaceId, selectedPath);
			if (isStale()) return "failed";
			ctx = createCtx(workspaceId);
			appStore.set((state) => ({
				workspace: {
					...state.workspace,
					snapshot: snapshot.workspace,
					files: snapshot.files,
					sidecars: snapshot.sidecars,
					commentsVersion: sidecarsChanged(
						state.workspace.sidecars,
						snapshot.sidecars,
					)
						? state.workspace.commentsVersion + 1
						: state.workspace.commentsVersion,
					assets: snapshot.assets,
					filesLoaded: true,
					lastOpenedPaths: snapshot.currentFile
						? {
								...state.workspace.lastOpenedPaths,
								[workspaceId]: snapshot.currentFile.path,
							}
						: state.workspace.lastOpenedPaths,
					status: "ready",
					error: null,
				},
				viewer: snapshot.currentFile
					? {
							currentPath: snapshot.currentFile.path,
							pendingPath: null,
							content: snapshot.currentFile.content,
							basedOnHash: snapshot.currentFile.contentHash,
							externalChange: { kind: "none" },
							status: "ready",
							error: null,
						}
					: {
							currentPath: null,
							pendingPath: null,
							content: "",
							basedOnHash: null,
							externalChange: { kind: "none" },
							status: "idle",
							error: null,
						},
			}));
			return "loaded";
		} catch (err) {
			if (isStale()) return "failed";
			workspaceStore.set((state) => ({
				...state,
				status: "error",
				error: describeApiError(err),
			}));
			return isUnauthorizedError(err) ? "unauthorized" : "failed";
		}
	},
);

/**
 * R36: the Worker has no push signal for "this workspace's sync was just
 * turned off on the Mac" — `disableCloudSyncForWorkspace` (apps/desktop,
 * frozen for this delivery) only flips local config and never calls the
 * Worker, and the Worker (apps/www/worker, also frozen) has no
 * unregister/disable route, only `ensureWorkspaceRegistered` (R28's
 * enable-only half). So a browser can only find out by asking: AppShell
 * polls this on an interval while a workspace is open, and if the workspace
 * ever does stop appearing in `listWorkspaces`, the caller (AppShell) drops
 * `workspace.snapshot` to null, which is what actually tears down the
 * subscription (its effect is keyed on snapshot identity) and swaps in a
 * clear message instead of leaving the socket open and inert.
 */
export type WorkspaceAvailability =
	| "available"
	| "unavailable"
	| "unauthorized"
	| "unknown";

export async function checkWorkspaceAvailable(
	workspaceId: string,
): Promise<WorkspaceAvailability> {
	try {
		const workspaces = await listWorkspaces({
			baseUrl: WORKER_BASE_URL,
			auth: { kind: "cookie" },
		});
		return workspaces.some((w) => w.workspaceId === workspaceId)
			? "available"
			: "unavailable";
	} catch (err) {
		if (isUnauthorizedError(err)) return "unauthorized";
		return "unknown";
	}
}

export function clearCurrentPath(): void {
	viewerStore.set((state) => ({
		...state,
		currentPath: null,
		pendingPath: null,
		content: "",
		basedOnHash: null,
		externalChange: { kind: "none" },
		status: "idle",
		error: null,
	}));
}

async function computeBytesHash(bytes: ArrayBuffer): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	const hashBytes = new Uint8Array(hash);
	return Array.from(hashBytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Advance baseline state (content, basedOnHash) and clear any pending
 * "deleted" banner. Use whenever we accept a new authoritative version of
 * the file. R31: there is no "conflict" classification here — apps/www's
 * editor is read-only, so the viewer's content can never diverge from the
 * remote copy the way the desktop app's editable one can
 * (apps/desktop/src/externalFileChange.ts). Every remote update simply wins.
 */
function cleanState(
	state: ViewerState,
	content: string,
	hash: string,
): ViewerState {
	return {
		...state,
		content,
		basedOnHash: hash,
		externalChange: { kind: "none" },
		status: "ready",
		error: null,
	};
}

export async function refreshFiles(): Promise<FileEntry[]> {
	const { backend, workspaceId } = requireCtx();
	try {
		const remote = await backend.getFiles(workspaceId);
		const visible: FileEntry[] = remote
			.filter((f) => !isSidecarRow(f.path))
			.map((f) => ({
				path: f.path,
				contentHash: f.contentHash,
				updatedAt: f.updatedAt,
				deleted: f.deleted,
			}));
		const sidecars = toSidecarMap(remote);
		workspaceStore.set((state) => ({
			...state,
			files: visible,
			sidecars,
			commentsVersion: sidecarsChanged(state.sidecars, sidecars)
				? state.commentsVersion + 1
				: state.commentsVersion,
			filesLoaded: true,
		}));
		return visible;
	} catch (err) {
		console.error("refreshFiles failed:", describeApiError(err));
		return [];
	}
}

export async function refreshAssets(): Promise<AssetEntry[]> {
	const { backend, workspaceId } = requireCtx();
	try {
		const remote = await backend.getAssets(workspaceId);
		const assets = remote.map((asset) => ({
			path: asset.path,
			storageId: asset.storageId,
			contentHash: asset.contentHash,
			updatedAt: asset.updatedAt,
			deleted: asset.deleted,
		}));
		workspaceStore.set((state) => ({ ...state, assets }));
		for (const asset of assets) {
			if (asset.deleted) assetDownloadUrlCache.delete(asset.path);
		}
		return assets;
	} catch (err) {
		console.error("refreshAssets failed:", describeApiError(err));
		return [];
	}
}

const assetDownloadUrlCache = new Map<
	string,
	{ storageId: string; url: string | null }
>();

export async function resolveAssetDownloadUrl(
	notePath: string,
	path: string,
): Promise<string | null> {
	const { backend } = requireCtx();
	const assetPath = resolveMarkdownAssetPath(notePath, path);
	const asset = workspaceStore
		.get()
		.assets.find((entry) => entry.path === assetPath && !entry.deleted);
	if (!asset) return null;
	const cached = assetDownloadUrlCache.get(assetPath);
	if (cached?.storageId === asset.storageId) return cached.url;
	// The browser is cookie-authenticated (same-origin), so the bare URL
	// works directly as an <img src> — no headers to attach on this side.
	const download = await backend.getAssetDownloadUrl(asset.storageId);
	const url = download?.url ?? null;
	assetDownloadUrlCache.set(assetPath, { storageId: asset.storageId, url });
	return url;
}

export async function uploadAssetFile(args: {
	path: string;
	file: File;
}): Promise<string> {
	const { backend, workspaceId, deviceId } = requireCtx();
	const bytes = await args.file.arrayBuffer();
	const contentHash = await computeBytesHash(bytes);
	const paths = assetPathsForNote(args.path, contentHash, args.file);
	const upload = await backend.generateAssetUploadUrl();
	const uploadResponse = await fetch(upload.url, {
		method: "POST",
		headers: {
			"Content-Type": args.file.type || "application/octet-stream",
			...upload.headers,
		},
		body: bytes,
	});
	if (!uploadResponse.ok) {
		throw new Error(`Asset upload failed: ${uploadResponse.status}`);
	}
	const uploadJson = (await uploadResponse.json()) as { storageId?: string };
	if (!uploadJson.storageId)
		throw new Error("Asset upload returned no storageId");
	await backend.pushAsset({
		workspaceId,
		path: paths.assetPath,
		storageId: uploadJson.storageId,
		contentHash,
		deviceId,
	});
	await refreshAssets();
	return paths.markdownPath;
}

function assetPathsForNote(notePath: string, hash: string, file: File) {
	const normalized = notePath.split("\\").join("/");
	const slashIndex = normalized.lastIndexOf("/");
	const folder = slashIndex === -1 ? "" : normalized.slice(0, slashIndex + 1);
	const name =
		slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
	const stem = stripMarkdownExtension(name) || "note";
	const markdownPath = `${stem}.assets/${hash.slice(0, 12)}.${imageExtension(file)}`;
	return {
		assetPath: `${folder}${markdownPath}`,
		markdownPath,
	};
}

function resolveMarkdownAssetPath(
	notePath: string,
	markdownPath: string,
): string {
	if (/^(data:|https?:|file:|blob:|\/)/i.test(markdownPath))
		return markdownPath;
	const normalizedNotePath = notePath.split("\\").join("/");
	const slashIndex = normalizedNotePath.lastIndexOf("/");
	const folder =
		slashIndex === -1 ? "" : normalizedNotePath.slice(0, slashIndex + 1);
	return normalizeWorkspacePath(`${folder}${markdownPath}`);
}

function normalizeWorkspacePath(path: string): string {
	const stack: string[] = [];
	for (const part of path.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			stack.pop();
			continue;
		}
		stack.push(part);
	}
	return stack.join("/");
}

function imageExtension(file: File): string {
	const fromName = file.name.split(".").pop()?.toLowerCase();
	if (fromName && /^(png|jpe?g|gif|webp|svg|bmp)$/.test(fromName)) {
		return fromName === "jpeg" ? "jpg" : fromName;
	}
	const fromMime = file.type.split("/")[1]?.toLowerCase();
	if (fromMime && /^(png|jpe?g|gif|webp|svg|bmp)$/.test(fromMime)) {
		return fromMime === "jpeg" ? "jpg" : fromMime;
	}
	return "png";
}

const LOADING_DELAY_MS = 150;

export const loadPath = latest(
	async ({ isStale }, path: string): Promise<void> => {
		const { backend, workspaceId } = requireCtx();
		// Snap the sidebar selection to the clicked file immediately, but keep
		// the editor pinned to the previous file's content until the new one
		// arrives. The loading status only flips after LOADING_DELAY_MS, so
		// fast loads never show a flash.
		viewerStore.set((s) => ({ ...s, pendingPath: path, error: null }));
		const timer = window.setTimeout(() => {
			if (isStale()) return;
			viewerStore.set((s) => ({ ...s, status: "loading", error: null }));
		}, LOADING_DELAY_MS);
		try {
			const remote = await backend.getFiles(workspaceId);
			if (isStale()) return;
			const file = remote.find((f) => f.path === path);
			if (!file) {
				viewerStore.set((s) => ({
					...s,
					currentPath: path,
					pendingPath: null,
					content: "",
					basedOnHash: null,
					externalChange: { kind: "none" },
					status: "error",
					error: `File not found: ${path}`,
				}));
				return;
			}
			viewerStore.set((s) => ({
				...cleanState(s, file.content, file.contentHash),
				currentPath: path,
				pendingPath: null,
			}));
			workspaceStore.set((state) => ({
				...state,
				lastOpenedPaths: {
					...state.lastOpenedPaths,
					[workspaceId]: path,
				},
			}));
		} catch (err) {
			if (isStale()) return;
			viewerStore.set((s) => ({
				...s,
				pendingPath: null,
				status: "error",
				error: describeApiError(err),
			}));
		} finally {
			window.clearTimeout(timer);
		}
	},
);

/**
 * R31: apps/www never edits or saves note content — this is a deliberate
 * no-op kept only because `EditorView.editable={false}` still requires an
 * `onLocalChange` handler (its ProseMirror surface already rejects direct
 * typing; this is the belt to that suspenders for any other path — e.g. the
 * front-matter properties panel — that might otherwise call it).
 */
export function updateEditorContent(_path: string, _content: string): void {}

export function markRemoteDeleted(path: string): void {
	const state = viewerStore.get();
	if (state.currentPath !== path) return;
	viewerStore.set({
		...state,
		externalChange: { kind: "deleted" },
		status: "error",
		error: "File deleted remotely",
	});
}

/**
 * Apply a remote update for the currently-open file. R31: there is no
 * save/conflict-resolution path in apps/www — the viewer is read-only, so
 * the remote copy always simply wins. A no-op when the hash hasn't actually
 * moved, so a redundant broadcast doesn't clear an unrelated "deleted"
 * banner or force an extra render.
 */
export function applyRemoteChange(
	path: string,
	remoteContent: string,
	remoteHash: string,
): void {
	const state = viewerStore.get();
	if (state.currentPath !== path) return;
	if (
		state.basedOnHash === remoteHash &&
		state.externalChange.kind === "none"
	) {
		return;
	}
	viewerStore.set(cleanState(state, remoteContent, remoteHash));
}
