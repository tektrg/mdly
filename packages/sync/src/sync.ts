import type { SyncBackend } from "./backend.js";
import {
	isInitialized,
	readConfig,
	readConfigOrDefault,
	readSyncState,
	writeCloudSyncConfig,
	writeSyncState,
} from "./config.js";
import type { FileSystem, InitFileSystem } from "./fs.js";
import { isUnchangedByStat } from "./scope.js";
import type {
	CloudSyncConfig,
	FileState,
	FolderSummaryEntry,
	RemoteAsset,
	SyncPlan,
	SyncProgress,
	SyncProgressCallback,
	SyncResult,
	WorkspaceConfig,
} from "./types.js";

/** Initialize a workspace for syncing. Creates .hubble/ config. */
export async function init(
	backend: SyncBackend,
	fs: InitFileSystem,
	opts: {
		workspacePath: string;
		workspaceName: string;
		deploymentUrl: string;
		backgroundSync?: boolean;
	},
): Promise<WorkspaceConfig> {
	const existing = await readConfigOrDefault(fs, opts.workspacePath);
	if (existing.cloudSync) return existing;

	const workspaceId =
		(await backend.getWorkspace(opts.workspaceName)) ??
		(await backend.createWorkspace(opts.workspaceName));

	const cloudSync: CloudSyncConfig = {
		provider: "cloudflare",
		deploymentUrl: opts.deploymentUrl,
		workspaceId,
		deviceId: crypto.randomUUID(),
		backgroundSync: opts.backgroundSync ?? false,
	};
	await writeSyncState(fs, opts.workspacePath, { lastSyncedAt: 0, files: {} });
	return writeCloudSyncConfig(fs, opts.workspacePath, cloudSync);
}

/**
 * Throttled progress emitter — calls the callback at most every ~100ms or
 * every N ops, NEVER per file. The app was once killed by an unthrottled
 * 765k-event stream; this shape must not come back. Always call `flush()`
 * at the end so the final 100% lands.
 */
export function createThrottledProgress(
	onProgress: SyncProgressCallback | undefined,
	intervalMs = 100,
	everyN = 20,
): {
	emit: (progress: SyncProgress) => void;
	flush: (progress: SyncProgress) => void;
	callCount: () => number;
} {
	let lastEmitAt = 0;
	let lastEmittedDone = -everyN;
	let calls = 0;
	function emit(progress: SyncProgress) {
		if (!onProgress) return;
		const now = Date.now();
		if (
			now - lastEmitAt >= intervalMs ||
			progress.done - lastEmittedDone >= everyN ||
			progress.phase === "done"
		) {
			lastEmitAt = now;
			lastEmittedDone = progress.done;
			calls++;
			onProgress(progress);
		}
	}
	function flush(progress: SyncProgress) {
		if (!onProgress) return;
		lastEmitAt = Date.now();
		lastEmittedDone = progress.done;
		calls++;
		onProgress(progress);
	}
	return { emit, flush, callCount: () => calls };
}

/**
 * Groups planned file ops by top-level folder for the review UI — nobody
 * selects 1,778 files individually. `bytes` uses in-memory content length
 * (an estimate, honest enough for a preview).
 */
export function summarizePlanByFolder(
	plan: Pick<SyncPlan, "toPush" | "toPull">,
): FolderSummaryEntry[] {
	const byFolder = new Map<string, { fileCount: number; bytes: number }>();
	for (const op of [...plan.toPush, ...plan.toPull]) {
		const slash = op.path.indexOf("/");
		const folder = slash === -1 ? "(root)" : op.path.slice(0, slash);
		const entry = byFolder.get(folder) ?? { fileCount: 0, bytes: 0 };
		entry.fileCount++;
		entry.bytes += op.content?.length ?? 0;
		byFolder.set(folder, entry);
	}
	return [...byFolder.entries()]
		.map(([folder, v]) => ({ folder, ...v }))
		.sort((a, b) => b.fileCount - a.fileCount);
}

/**
 * Decides everything without doing anything (D-LW3): returns the full op
 * set plus the folder-grouped summary the review UI shows. The dry-run
 * preview and the real count come from this SAME call, so the number shown
 * before enabling is the number that actually happens.
 */
export async function plan(
	backend: SyncBackend,
	fs: FileSystem,
	workspacePath: string,
): Promise<SyncPlan> {
	const config = await readConfig(fs, workspacePath);
	if (!config.cloudSync) {
		throw new Error(
			`No Cloud Sync config in ${workspacePath}. Run \`hubble cloud connect\` first.`,
		);
	}
	const state = await readSyncState(fs, workspacePath);
	const { workspaceId } = config.cloudSync;

	const localFiles = await fs.listMarkdownFiles(workspacePath);
	const localByPath = new Map(localFiles.map((f) => [f.relativePath, f]));

	const remoteFiles = await backend.getFiles(workspaceId, {
		includeDeleted: true,
	});
	const remoteByPath = new Map(remoteFiles.map((f) => [f.path, f]));

	const nextPlan: SyncPlan = {
		toPush: [],
		toPull: [],
		toDelete: [],
		conflicts: [],
		unchanged: 0,
		assetOps: { toPush: [], toPull: [], toDelete: [] },
		folders: [],
		totalOps: 0,
	};

	// --- Decide for files that exist locally ---
	for (const local of localFiles) {
		const prev = state.files[local.relativePath];
		const remote = remoteByPath.get(local.relativePath);
		// Cheap stat hint: unchanged stat means "might be unchanged" — skip
		// the hash comparison for the localChanged decision. A stat mismatch
		// ALWAYS falls through to hash verification (mtime is never proof).
		const statUnchanged = isUnchangedByStat(prev, local.mtime, local.size);
		const localChanged = statUnchanged
			? false
			: !prev || prev.hash !== local.hash;

		if (remote?.deleted) {
			if (prev && prev.hash !== local.hash) {
				nextPlan.toPush.push({
					path: local.relativePath,
					hash: local.hash,
					content: local.content,
					mtime: local.mtime,
					size: local.size,
				});
			} else {
				nextPlan.toDelete.push({ path: local.relativePath, kind: "local" });
			}
			continue;
		}

		if (!remote) {
			nextPlan.toPush.push({
				path: local.relativePath,
				hash: local.hash,
				content: local.content,
				mtime: local.mtime,
				size: local.size,
			});
			continue;
		}

		const remoteChanged = !prev || prev.hash !== remote.contentHash;
		const diverged = remoteChanged && remote.contentHash !== local.hash;

		if (diverged && localChanged) {
			nextPlan.conflicts.push(local.relativePath);
		} else if (diverged) {
			nextPlan.toPull.push({
				path: local.relativePath,
				hash: remote.contentHash,
				content: remote.content,
			});
		} else if (localChanged) {
			nextPlan.toPush.push({
				path: local.relativePath,
				hash: local.hash,
				content: local.content,
				mtime: local.mtime,
				size: local.size,
			});
		} else {
			nextPlan.unchanged++;
		}
	}

	// --- Decide local deletions (in state but no longer on disk) ---
	for (const [path, prev] of Object.entries(state.files)) {
		if (localByPath.has(path)) continue;

		const remote = remoteByPath.get(path);
		if (remote && !remote.deleted && remote.contentHash !== prev.hash) {
			nextPlan.toPull.push({
				path,
				hash: remote.contentHash,
				content: remote.content,
			});
		} else if (remote && !remote.deleted) {
			nextPlan.toDelete.push({ path, kind: "remote-tombstone" });
		}
		// Remote already deleted or unknown — state cleanup, no op.
	}

	// --- Decide new remote files not present locally ---
	for (const remote of remoteFiles) {
		if (remote.deleted) continue;
		if (localByPath.has(remote.path)) continue;
		if (state.files[remote.path]) continue;
		nextPlan.toPull.push({
			path: remote.path,
			hash: remote.contentHash,
			content: remote.content,
		});
	}

	// --- Decide asset ops ---
	const prevAssets = state.assets ?? {};
	const localAssets = await fs.listAssetFiles(workspacePath);
	const localAssetByPath = new Map(localAssets.map((a) => [a.relativePath, a]));
	const remoteAssets = await backend.getAssets(workspaceId);
	const remoteAssetByPath = new Map(remoteAssets.map((a) => [a.path, a]));

	for (const local of localAssets) {
		const prev = prevAssets[local.relativePath];
		const remote = remoteAssetByPath.get(local.relativePath);
		const statUnchanged = isUnchangedByStat(prev, local.mtime, local.size);
		const localChanged = statUnchanged
			? false
			: !prev || prev.hash !== local.hash;

		if (remote?.deleted) {
			if (prev && prev.hash !== local.hash) {
				nextPlan.assetOps.toPush.push({
					path: local.relativePath,
					hash: local.hash,
					mtime: local.mtime,
					size: local.size,
				});
			} else {
				nextPlan.assetOps.toDelete.push(local.relativePath);
			}
			continue;
		}
		if (!remote) {
			nextPlan.assetOps.toPush.push({
				path: local.relativePath,
				hash: local.hash,
				mtime: local.mtime,
				size: local.size,
			});
			continue;
		}
		const remoteChanged = !prev || prev.hash !== remote.contentHash;
		const diverged = remoteChanged && remote.contentHash !== local.hash;
		if (diverged) {
			nextPlan.assetOps.toPull.push(local.relativePath);
		} else if (localChanged) {
			nextPlan.assetOps.toPush.push({
				path: local.relativePath,
				hash: local.hash,
				mtime: local.mtime,
				size: local.size,
			});
		}
	}
	for (const path of Object.keys(prevAssets)) {
		if (localAssetByPath.has(path)) continue;
		const remote = remoteAssetByPath.get(path);
		if (remote && !remote.deleted) {
			nextPlan.assetOps.toDelete.push(path);
		}
	}
	for (const remote of remoteAssets) {
		if (remote.deleted) continue;
		if (localAssetByPath.has(remote.path)) continue;
		if (prevAssets[remote.path]) continue;
		nextPlan.assetOps.toPull.push(remote.path);
	}

	nextPlan.folders = summarizePlanByFolder(nextPlan);
	nextPlan.totalOps =
		nextPlan.toPush.length +
		nextPlan.toPull.length +
		nextPlan.toDelete.length +
		nextPlan.conflicts.length +
		nextPlan.assetOps.toPush.length +
		nextPlan.assetOps.toPull.length +
		nextPlan.assetOps.toDelete.length;
	return nextPlan;
}

/**
 * Performs a previously computed plan, emitting throttled progress. Reads
 * config/state fresh (cheap local reads) so `sync()` stays a thin
 * `plan()` + `execute()` wrapper and nothing that calls it today breaks.
 */
export async function execute(
	computed: SyncPlan,
	backend: SyncBackend,
	fs: FileSystem,
	workspacePath: string,
	onProgress?: SyncProgressCallback,
): Promise<SyncResult> {
	const config = await readConfig(fs, workspacePath);
	if (!config.cloudSync) {
		throw new Error(
			`No Cloud Sync config in ${workspacePath}. Run \`hubble cloud connect\` first.`,
		);
	}
	const state = await readSyncState(fs, workspacePath);
	const { workspaceId, deviceId } = config.cloudSync;

	const result: SyncResult = {
		pushed: [],
		pulled: [],
		deleted: [],
		conflicts: [],
		unchanged: computed.unchanged,
		assetsPushed: 0,
		assetsPulled: 0,
		assetsDeleted: 0,
	};
	const nextFiles: Record<string, FileState> = { ...state.files };
	const now = Date.now();
	const total = Math.max(computed.totalOps, 1);
	let done = 0;
	const throttle = createThrottledProgress(onProgress);
	function tick(currentPath?: string, phase: SyncProgress["phase"] = "push") {
		done++;
		throttle.emit({ phase, done, total, currentPath });
	}

	function statFor(hash: string, mtime?: number, size?: number): FileState {
		return { hash, lastSyncedAt: now, mtime, size };
	}

	async function pushLocal(
		path: string,
		hash: string,
		content: string,
		mtime?: number,
		size?: number,
	) {
		await backend.pushFile({
			workspaceId,
			path,
			contentHash: hash,
			content,
			deviceId,
		});
		nextFiles[path] = statFor(hash, mtime, size);
		result.pushed.push(path);
	}

	async function ensureParentDir(path: string) {
		const slash = path.lastIndexOf("/");
		if (slash > 0)
			await fs.ensureDir(`${workspacePath}/${path.slice(0, slash)}`);
	}

	for (const op of computed.toPush) {
		await pushLocal(op.path, op.hash, op.content, op.mtime, op.size);
		tick(op.path, "push");
	}

	// Pulls + deletes + conflicts need remote content fresh at execute time
	// for correctness; re-fetch once rather than per file.
	const remoteFiles = await backend.getFiles(workspaceId, {
		includeDeleted: true,
	});
	const remoteByPath = new Map(remoteFiles.map((f) => [f.path, f]));

	// A path planned as a push whose remote turned into a tombstone between
	// plan and execute honors the tombstone unless genuinely modified —
	// reconcile here rather than re-pushing blindly.
	for (const pushedPath of [...result.pushed]) {
		const remote = remoteByPath.get(pushedPath);
		if (!remote?.deleted) continue;
		const prev = state.files[pushedPath];
		const planned = computed.toPush.find((p) => p.path === pushedPath);
		if (prev && planned && prev.hash !== planned.hash) continue; // genuinely modified — push stands
		try {
			await fs.deleteFile(`${workspacePath}/${pushedPath}`);
		} catch {
			// Already gone.
		}
		delete nextFiles[pushedPath];
		result.pushed = result.pushed.filter((p) => p !== pushedPath);
		if (!result.deleted.includes(pushedPath)) result.deleted.push(pushedPath);
	}

	for (const op of computed.toPull) {
		const remote = remoteByPath.get(op.path);
		const content = remote && !remote.deleted ? remote.content : op.content;
		const hash = remote && !remote.deleted ? remote.contentHash : op.hash;
		await ensureParentDir(op.path);
		await fs.writeFile(`${workspacePath}/${op.path}`, content);
		nextFiles[op.path] = statFor(hash);
		result.pulled.push(op.path);
		tick(op.path, "pull");
	}

	for (const op of computed.toDelete) {
		if (op.kind === "local") {
			try {
				await fs.deleteFile(`${workspacePath}/${op.path}`);
			} catch {
				// Already gone.
			}
			delete nextFiles[op.path];
			result.deleted.push(op.path);
		} else {
			await backend.softDeleteFile({
				workspaceId,
				path: op.path,
				deviceId,
			});
			delete nextFiles[op.path];
			result.deleted.push(op.path);
		}
		tick(op.path, "pull");
	}

	for (const conflictPath of computed.conflicts) {
		const remote = remoteByPath.get(conflictPath);
		// Local side is whatever is on disk at execute time.
		let localContent: string;
		try {
			localContent = await fs.readFile(`${workspacePath}/${conflictPath}`);
		} catch {
			continue;
		}
		if (!remote || remote.deleted) continue;
		const conflictName = toConflictName(conflictPath);
		await fs.writeFile(`${workspacePath}/${conflictName}`, localContent);
		await fs.writeFile(`${workspacePath}/${conflictPath}`, remote.content);
		nextFiles[conflictPath] = statFor(remote.contentHash);
		result.conflicts.push(conflictPath);
		tick(conflictPath, "pull");
	}

	// --- Asset execution ---
	const prevAssets = state.assets ?? {};
	const nextAssets: Record<string, FileState> = { ...prevAssets };
	const remoteAssets = await backend.getAssets(workspaceId);
	const remoteAssetByPath = new Map(remoteAssets.map((a) => [a.path, a]));

	async function pushAsset(
		path: string,
		hash: string,
		mtime?: number,
		size?: number,
	) {
		const upload = await backend.generateAssetUploadUrl();
		const data = await fs.readBinaryFile(`${workspacePath}/${path}`);
		const res = await fetch(upload.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/octet-stream",
				...upload.headers,
			},
			body: data,
		});
		const { storageId } = (await res.json()) as { storageId: string };
		await backend.pushAsset({
			workspaceId,
			path,
			storageId,
			contentHash: hash,
			deviceId,
		});
		nextAssets[path] = statFor(hash, mtime, size);
		result.assetsPushed++;
	}

	async function pullAsset(remote: RemoteAsset) {
		const download = await backend.getAssetDownloadUrl(remote.storageId);
		if (!download) return;
		const res = await fetch(download.url, { headers: download.headers });
		const buf = new Uint8Array(await res.arrayBuffer());
		await ensureParentDir(remote.path);
		await fs.writeBinaryFile(`${workspacePath}/${remote.path}`, buf);
		nextAssets[remote.path] = statFor(remote.contentHash);
		result.assetsPulled++;
	}

	for (const op of computed.assetOps.toPush) {
		try {
			await pushAsset(op.path, op.hash, op.mtime, op.size);
		} catch (error) {
			if (!isGoneError(error)) throw error;
		}
		tick(op.path, "assets");
	}
	for (const path of computed.assetOps.toPull) {
		const remote = remoteAssetByPath.get(path);
		if (remote && !remote.deleted) await pullAsset(remote);
		tick(path, "assets");
	}
	for (const path of computed.assetOps.toDelete) {
		// toDelete mixes local deletes and remote tombstones; disambiguate
		// by whether the file still exists locally per the plan's inputs.
		const stillTrackedLocally = computed.assetOps.toPush.some(
			(p) => p.path === path,
		);
		if (!stillTrackedLocally) {
			try {
				await fs.deleteFile(`${workspacePath}/${path}`);
				delete nextAssets[path];
				result.assetsDeleted++;
			} catch {
				// Was a remote tombstone after all — push it.
				try {
					await backend.softDeleteAsset({ workspaceId, path, deviceId });
					delete nextAssets[path];
					result.assetsDeleted++;
				} catch {
					delete nextAssets[path];
				}
			}
		}
		tick(path, "assets");
	}

	await writeSyncState(fs, workspacePath, {
		lastSyncedAt: now,
		files: nextFiles,
		assets: nextAssets,
	});
	throttle.flush({ phase: "done", done: total, total });
	return result;
}

function isGoneError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

/**
 * Thin wrapper over `plan()` + `execute()` so nothing that calls `sync()`
 * today breaks. New surfaces (preview dialog, progress bar) call the two
 * halves directly.
 */
export async function sync(
	backend: SyncBackend,
	fs: FileSystem,
	workspacePath: string,
	onProgress?: SyncProgressCallback,
): Promise<SyncResult> {
	if (onProgress) onProgress({ phase: "scan", done: 0, total: null });
	const computed = await plan(backend, fs, workspacePath);
	return execute(computed, backend, fs, workspacePath, onProgress);
}

/** Get current sync status without performing a sync. */
export async function status(fs: FileSystem, workspacePath: string) {
	if (!(await isInitialized(fs, workspacePath))) {
		return { initialized: false as const };
	}
	const config = await readConfig(fs, workspacePath);
	const state = await readSyncState(fs, workspacePath);
	const localFiles = await fs.listMarkdownFiles(workspacePath);

	let pendingChanges = 0;
	for (const f of localFiles) {
		const prev = state.files[f.relativePath];
		if (isUnchangedByStat(prev, f.mtime, f.size)) continue;
		if (!prev || prev.hash !== f.hash) pendingChanges++;
	}

	return {
		initialized: true as const,
		cloudSync: config.cloudSync,
		lastSyncedAt: state.lastSyncedAt,
		localFiles: localFiles.length,
		trackedFiles: Object.keys(state.files).length,
		pendingChanges,
	};
}

function toConflictName(filePath: string): string {
	const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
	const dot = filePath.lastIndexOf(".");
	if (dot === -1) return `${filePath}.conflict-${ts}`;
	return `${filePath.slice(0, dot)}.conflict-${ts}${filePath.slice(dot)}`;
}
