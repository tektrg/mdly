import type { RemoteFile, SyncBackend } from "@hubble.md/sync";
import {
	CloudflareResponseError,
	createCloudflareBackend,
	createVersionLedger,
	listWorkspaces,
	type VersionLedger,
} from "@mdly/cloudflare-client";
import { stripMarkdownExtension } from "@mdly/workspace-kit";
import { describeApiError, isUnauthorizedError } from "../connection/apiError";
import { ensureDeviceId } from "../connection/deviceId";
import { WORKER_BASE_URL } from "../connection/workerUrl";
import { latest } from "../lib/latest";
import {
	isSidecarRow,
	type SidecarEntry,
	sidecarsChanged,
	toSidecarMap,
} from "./sidecars";
import {
	type AssetEntry,
	appStore,
	type FileEntry,
	resetState,
	type ViewerState,
	viewerStore,
	workspaceStore,
} from "./state";

type Ctx = {
	backend: SyncBackend;
	workspaceId: string;
	deviceId: string;
	/**
	 * Shared self-echo ledger (DO row-read frequency fix, 2b): the backend
	 * above records every mutation version here, and AppShell passes this
	 * SAME object to the subscriber it constructs — so this tab never
	 * re-lists in response to its own writes. Created per workspace
	 * context, never global: version counters are per-workspace, and a
	 * global ledger could suppress another workspace's change that happens
	 * to share a version number.
	 */
	versionLedger: VersionLedger;
};

let ctx: Ctx | null = null;

function createCtx(workspaceId: string): Ctx {
	const versionLedger = createVersionLedger();
	return {
		backend: createCloudflareBackend({
			baseUrl: WORKER_BASE_URL,
			auth: { kind: "cookie" },
			versionLedger,
		}),
		workspaceId,
		deviceId: ensureDeviceId(),
		versionLedger,
	};
}

export function initActions(workspaceId: string): void {
	ctx = createCtx(workspaceId);
}

export function teardownActions(): void {
	ctx = null;
	discardPendingSave();
	resetState();
}

/** Drop any staged edit without pushing (workspace is going away). */
function discardPendingSave(): void {
	if (saveTimer !== null) {
		clearTimeout(saveTimer);
		saveTimer = null;
	}
	pendingSave = null;
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
							saveError: null,
						}
					: {
							currentPath: null,
							pendingPath: null,
							content: "",
							basedOnHash: null,
							externalChange: { kind: "none" },
							status: "idle",
							error: null,
							saveError: null,
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
		saveError: null,
	}));
}

async function computeBytesHash(bytes: BufferSource): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	const hashBytes = new Uint8Array(hash);
	return Array.from(hashBytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * SHA-256 hex of the UTF-8 bytes — byte-identical to `contentHash` in
 * `@hubble.md/sync` (same algorithm, same encoding), but local: importing
 * that package for real would drag Node-only modules into the web bundle.
 * The server stores whatever hash we send and the Mac compares it against
 * its own hash of the pulled content, so this MUST stay in sync with it.
 */
export function computeStringHash(content: string): Promise<string> {
	return computeBytesHash(new TextEncoder().encode(content));
}

/**
 * Advance baseline state (content, basedOnHash) and clear any pending
 * "deleted" banner. Use whenever we accept a new authoritative version of
 * the file — a remote update winning, or our own push landing. (The
 * "conflict" classification for a remote change racing a local edit arrives
 * with the base-version guard; until then every remote update simply wins.)
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
		saveError: null,
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
 * Web write-back: stage a local edit for debounced push to the cloud.
 * Called on every editor update; the actual `pushFile` fires after
 * `SAVE_DEBOUNCE_MS` of quiet. A path switch with an unsent edit staged
 * flushes the old path first, so it can never be dropped or written under
 * the new path.
 */
const SAVE_DEBOUNCE_MS = 1000;

type PendingSave = { path: string; content: string };
let pendingSave: PendingSave | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function updateEditorContent(path: string, content: string): void {
	if (pendingSave && pendingSave.path !== path) {
		void flushPendingSave();
	}
	pendingSave = { path, content };
	if (saveTimer !== null) clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		saveTimer = null;
		void flushPendingSave();
	}, SAVE_DEBOUNCE_MS);
}

/** Push the staged edit now (if any). The kit's forced-save path calls this. */
export async function flushPendingSave(): Promise<void> {
	if (saveTimer !== null) {
		clearTimeout(saveTimer);
		saveTimer = null;
	}
	const staged = pendingSave;
	pendingSave = null;
	if (!staged) return;
	try {
		await pushNoteContent(staged.path, staged.content);
	} catch (err) {
		// Never break the editor for a failed push: record it for the save
		// banner and let the next keystroke re-stage a fresh push
		// (auto-retry). `status`/`error` are untouched on purpose — flipping
		// those would unmount the editor.
		const viewer = viewerStore.get();
		if (viewer.currentPath === staged.path) {
			viewerStore.set({ ...viewer, saveError: describeApiError(err) });
		}
		console.error("updateEditorContent failed:", describeApiError(err));
	}
}

/** Stage `content` and push immediately. The kit's `onSave` calls this. */
export async function saveNoteNow(
	path: string,
	content: string,
): Promise<void> {
	pendingSave = { path, content };
	await flushPendingSave();
}

/** True when an edit for `path` is staged but not yet pushed. */
export function hasPendingSaveFor(path: string): boolean {
	return pendingSave?.path === path;
}

async function pushNoteContent(path: string, content: string): Promise<void> {
	const { backend, workspaceId, deviceId } = requireCtx();
	// Snapshot the viewer baseline BEFORE the push: it is the hash this edit
	// is based on, and the push below advances it on success.
	const viewer = viewerStore.get();
	const baseHash = viewer.currentPath === path ? viewer.basedOnHash : null;
	const hash = await computeStringHash(content);
	try {
		await backend.pushFile({
			workspaceId,
			path,
			contentHash: hash,
			content,
			deviceId,
			...(baseHash ? { expectedContentHash: baseHash } : {}),
		});
	} catch (err) {
		const remote = readConflictRemote(err);
		if (remote && viewer.currentPath === path) {
			await preserveConflictCopy(path, content, hash, remote);
			return;
		}
		throw err;
	}
	// Advance the local baseline to what we just wrote: our own broadcast
	// echo carries this same hash, so `applyRemoteChange` correctly no-ops
	// on it instead of "reloading" our own words. (The subscriber's
	// self-echo ledger suppresses the re-list for our own version; these
	// store updates are what keeps the sidebar + baseline correct anyway.)
	// `content` advances too: a remote broadcast arriving between our push
	// and its echo must compare against OUR words, not stale ones.
	const current = viewerStore.get();
	if (current.currentPath === path) {
		viewerStore.set({
			...current,
			content,
			basedOnHash: hash,
			saveError: null,
		});
	}
	const workspace = workspaceStore.get();
	if (workspace.files.some((f) => f.path === path && f.contentHash !== hash)) {
		workspaceStore.set({
			...workspace,
			files: workspace.files.map((f) =>
				f.path === path ? { ...f, contentHash: hash } : f,
			),
		});
	}
}

/** Dismiss the save-error banner (the next keystroke retries anyway). */
export function clearSaveError(): void {
	const viewer = viewerStore.get();
	if (viewer.saveError !== null) {
		viewerStore.set({ ...viewer, saveError: null });
	}
}

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

/** Narrow a caught push error to the 409 conflict's remote side, if any. */
export function readConflictRemote(
	err: unknown,
): { currentContentHash: string; currentContent: string } | null {
	if (
		!(err instanceof CloudflareResponseError) ||
		err.status !== 409 ||
		err.code !== "WRITE_CONFLICT"
	) {
		return null;
	}
	// `details` is untrusted wire data — narrow before use.
	const details = err.details as
		| { currentContentHash?: unknown; content?: unknown }
		| null
		| undefined;
	if (
		typeof details?.currentContentHash !== "string" ||
		typeof details?.content !== "string"
	) {
		return null;
	}
	return {
		currentContentHash: details.currentContentHash,
		currentContent: details.content,
	};
}

/**
 * Warn-once + keep-both: the server rejected our push because the file moved
 * under us. Our words go to a timestamped conflict copy (same naming rule as
 * the desktop sync's `toConflictName` in `packages/sync/src/sync.ts` —
 * duplicated here because that package isn't browser-importable), the
 * baseline advances to the remote hash we've now reconciled, and the banner
 * offers Reload. If the user keeps typing instead, the next push carries the
 * remote hash as its base and wins openly — warned once, nothing lost.
 */
async function preserveConflictCopy(
	path: string,
	ourContent: string,
	ourHash: string,
	remote: { currentContentHash: string; currentContent: string },
): Promise<void> {
	const { backend, workspaceId, deviceId } = requireCtx();
	const copyPath = toConflictName(path);
	try {
		await backend.pushFile({
			workspaceId,
			path: copyPath,
			contentHash: ourHash,
			content: ourContent,
			deviceId,
		});
	} catch (copyErr) {
		const viewer = viewerStore.get();
		if (viewer.currentPath === path) {
			viewerStore.set({
				...viewer,
				saveError: `Conflict detected but the safety copy failed: ${describeApiError(copyErr)} — your words are still in the editor.`,
			});
		}
		console.error("conflict copy failed:", describeApiError(copyErr));
		return;
	}
	const viewer = viewerStore.get();
	if (viewer.currentPath === path) {
		viewerStore.set({
			...viewer,
			basedOnHash: remote.currentContentHash,
			externalChange: { kind: "conflict", copyPath },
			saveError: null,
		});
	}
	await refreshFiles();
}

/** Timestamped conflict-copy name. Mirrors `toConflictName` in sync.ts. */
function toConflictName(filePath: string): string {
	// 14 chars = YYYYMMDDHHmmss. (sync.ts slices 15, which keeps ISO's
	// trailing "." and yields "..md" — cosmetic wart not worth copying.)
	const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
	const dot = filePath.lastIndexOf(".");
	if (dot === -1) return `${filePath}.conflict-${ts}`;
	return `${filePath.slice(0, dot)}.conflict-${ts}${filePath.slice(dot)}`;
}

/**
 * Apply a remote update for the currently-open file. Two guards before the
 * remote copy wins: (1) identical hash = nothing moved ( absorbs our own
 * echo and redundant broadcasts); (2) an edit staged but not yet pushed is
 * NEWER than this broadcast — touch nothing, so the kit doesn't snap the
 * editor out from under typing fingers. The staged push carries our old
 * base hash and will 409 into the conflict flow if the remote really moved.
 */
export function applyRemoteChange(
	path: string,
	remoteContent: string,
	remoteHash: string,
): void {
	const state = viewerStore.get();
	if (state.currentPath !== path) return;
	// Hash-identical = nothing moved: absorbs our own echo and redundant
	// broadcasts WITHOUT clearing an unrelated banner (deleted/conflict).
	if (state.basedOnHash === remoteHash) {
		return;
	}
	if (hasPendingSaveFor(path)) return;
	viewerStore.set(cleanState(state, remoteContent, remoteHash));
}
