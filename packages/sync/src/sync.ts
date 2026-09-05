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
import { contentHash } from "./fs.js";
import { isUnchangedByStat } from "./scope.js";
import { mergeJsonlUnion } from "./sidecarMerge.js";
import {
	isPushableSidecarPath,
	isSidecarPath,
	isSyncedSidecarPath,
} from "./sidecarScope.js";
import type {
	CloudSyncConfig,
	FileState,
	FolderSummaryEntry,
	RejectedFile,
	RemoteAsset,
	RemoteFile,
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
	// tombstone-then-403-fence (Step 1): remote `.mdly/**` rows are sidecars
	// the local walkers prune, so they must never enter the note paths below
	// — otherwise a cloud comment log pulls once, then reads as
	// locally-deleted forever and dies on a 403 soft-delete.
	const noteRemoteFiles = remoteFiles.filter((f) => !isSidecarPath(f.path));
	// Round 3: the fenced-out rows stay in this local variable for
	// planSidecars() below. The note path above is not un-fenced.
	const sidecarRemoteFiles = remoteFiles.filter((f) => isSidecarPath(f.path));
	const remoteByPath = new Map(noteRemoteFiles.map((f) => [f.path, f]));

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
		// Fence: sidecars never live in the note paths — a pulled comment log
		// is pruned by the walkers, so without this it would read as
		// locally-deleted and escalate to a fatal remote tombstone.
		if (isSidecarPath(path)) continue;
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
	for (const remote of noteRemoteFiles) {
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

	// --- Decide sidecar ops (Round 3 planned, Round 4 executes) ---
	// Sidecars never enter toPush/toPull/toDelete/conflicts above — the
	// separate sidecarOps block is what keeps the Round 1 fence permanent.
	nextPlan.sidecarOps = await planSidecars(
		fs,
		workspacePath,
		sidecarRemoteFiles,
		state.sidecars ?? {},
	);

	// Permanently-rejected files (HTTP 413 on an earlier run) are not
	// re-planned while their content is unchanged — retrying them every run
	// would jam the loop the same way the original failure did. An edited
	// file (new hash) plans normally: it may fit now. Withheld ops travel on
	// `skippedPushes` so execute() (and dry-run previews) still report them
	// instead of going silent.
	const skippedPushes: NonNullable<SyncPlan["skippedPushes"]> = [];
	nextPlan.toPush = nextPlan.toPush.filter((op) => {
		const entry = state.rejectedFiles?.[op.path];
		if (entry && entry.hash === op.hash) {
			skippedPushes.push({
				path: op.path,
				hash: op.hash,
				code: entry.code,
				message: entry.message,
			});
			return false;
		}
		return true;
	});
	nextPlan.skippedPushes = skippedPushes;

	// Rejected entries for files that no longer exist locally are dead
	// weight: drop them from persisted state when this plan executes.
	nextPlan.prunedRejected = Object.keys(state.rejectedFiles ?? {}).filter(
		(path) => !localByPath.has(path),
	);

	nextPlan.folders = summarizePlanByFolder(nextPlan);
	// totalOps means "work to do" — withheld pushes are reported, not
	// worked, and live on `skippedPushes` as their own field. Sidecar ops
	// ARE counted (Round 4): execute() now performs them, so the progress
	// total must promise exactly this much work. (Round 3 excluded them
	// while execute was a sidecar no-op.)
	nextPlan.totalOps =
		nextPlan.toPush.length +
		nextPlan.toPull.length +
		nextPlan.toDelete.length +
		nextPlan.conflicts.length +
		nextPlan.assetOps.toPush.length +
		nextPlan.assetOps.toPull.length +
		nextPlan.assetOps.toDelete.length +
		(nextPlan.sidecarOps?.toPush.length ?? 0) +
		(nextPlan.sidecarOps?.toPull.length ?? 0) +
		(nextPlan.sidecarOps?.merged.length ?? 0);
	return nextPlan;
}

/**
 * Plans sidecar intent without doing anything (Round 3, codename
 * sidecar-union-plan): compares local sidecar files against the fenced-out
 * remote sidecar rows and the `state.sidecars` baseline, and classifies each
 * allowlisted path into toPush / toPull / merged.
 *
 * Rules:
 * - Local only → push, but only if `isPushableSidecarPath` (this slotless
 *   device may never push a slotted browser sibling — the server would 403).
 * - Remote only (live) → pull. This includes baseline-known but locally
 *   missing: a comment log is append-only and never intentionally deleted,
 *   so a missing local file is a wipe or a fresh clone, and re-pulling is
 *   the safe answer in both.
 * - Both present, hashes equal → no op.
 * - Diverged, local unchanged vs baseline → pull.
 * - Diverged, local also changed → merged (union via `mergeJsonlUnion`),
 *   NEVER a conflict. Except on a path this device may not push (slotted
 *   sibling): a merged result could never be pushed back, so take remote.
 * - Remote tombstoned → IGNORE, always. A comment log is append-only and
 *   sync must never delete one, so there is deliberately no delete case.
 *
 * Sidecars never enter `plan.conflicts`, so `toConflictName` can never be
 * reached for a `.mdly` path. Non-allowlisted `.mdly` rows (revision blobs,
 * …) stay ignored exactly like Round 1.
 */
export async function planSidecars(
	fs: FileSystem,
	workspacePath: string,
	sidecarRemoteFiles: RemoteFile[],
	baseline: Record<string, FileState>,
): Promise<NonNullable<SyncPlan["sidecarOps"]>> {
	const ops: NonNullable<SyncPlan["sidecarOps"]> = {
		toPush: [],
		toPull: [],
		merged: [],
	};
	const localFiles = await fs.listSidecarFiles(workspacePath);
	const localByPath = new Map(localFiles.map((f) => [f.relativePath, f]));
	// Only allowlisted sidecars are plannable; the rest stays ignored.
	const remoteByPath = new Map(
		sidecarRemoteFiles
			.filter((f) => isSyncedSidecarPath(f.path))
			.map((f) => [f.path, f]),
	);

	for (const local of localFiles) {
		// Belt-and-braces: the walker allowlist should already agree, but a
		// non-allowlisted local file must never be pushed.
		if (!isSyncedSidecarPath(local.relativePath)) continue;
		const remote = remoteByPath.get(local.relativePath);
		if (!remote || remote.deleted) {
			// No live remote row. A tombstone is answered with IGNORE (never
			// delete an append-only log); a genuinely missing row pushes what
			// this device may write and skips what it may not.
			if (remote?.deleted) continue;
			if (!isPushableSidecarPath(local.relativePath)) continue;
			ops.toPush.push({
				path: local.relativePath,
				hash: local.hash,
				content: local.content,
				mtime: local.mtime,
				size: local.size,
			});
			continue;
		}
		if (remote.contentHash === local.hash) continue;
		const prev = baseline[local.relativePath];
		const localChanged = !prev || prev.hash !== local.hash;
		if (!localChanged || !isPushableSidecarPath(local.relativePath)) {
			// Unchanged locally → take remote. Unpushable (slotted sibling)
			// with local edits → also take remote: a merged result could
			// never be pushed back, so pulling is the only convergent move.
			ops.toPull.push({
				path: local.relativePath,
				hash: remote.contentHash,
				content: remote.content,
			});
			continue;
		}
		const content = mergeJsonlUnion(local.content, remote.content);
		ops.merged.push({
			path: local.relativePath,
			hash: await contentHash(content),
			content,
		});
	}

	for (const remote of remoteByPath.values()) {
		if (remote.deleted) continue;
		if (localByPath.has(remote.path)) continue;
		ops.toPull.push({
			path: remote.path,
			hash: remote.contentHash,
			content: remote.content,
		});
	}

	// Deterministic plan order regardless of walker/backend ordering.
	for (const list of [ops.toPush, ops.toPull, ops.merged]) {
		list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	}
	return ops;
}

/** Inputs executeSidecars() needs from its execute() call site. */
export type ExecuteSidecarsDeps = {
	backend: SyncBackend;
	fs: FileSystem;
	workspacePath: string;
	workspaceId: string;
	deviceId: string;
	now: number;
	/** Fresh-at-execute-time allowlisted sidecar rows (mirrors the note re-fetch). */
	remoteByPath: Map<string, RemoteFile>;
	/** Mutable baseline accumulator, persisted by the caller's writeState. */
	nextSidecars: Record<string, FileState>;
	result: SyncResult;
	tick: (currentPath?: string, phase?: SyncProgress["phase"]) => void;
};

/**
 * Performs a previously planned sidecar block (Round 4): pushes, pulls,
 * and union-merges comment logs + history index shards.
 *
 * - toPush goes through backend.pushFile with the SAME per-file try/catch
 *   as the note push loop, so one 403 or 413 can never abort the run.
 *   Failures land in result.failedFiles with `kind: "sidecar"`.
 * - toPull resolves content against the fresh execute-time remote (live
 *   row wins, planned content is the fallback), writes via fs.writeFile
 *   with ensureParentDir first, and records the baseline.
 * - merged writes the union locally AND pushes it; the baseline is
 *   recorded only after the push succeeds, so a failed push retries the
 *   same union next run instead of believing it converged.
 *
 * Still no delete path: an append-only log is never removed. Successes
 * count on result.sidecarsPushed/Pulled/Merged — the note pushed/pulled
 * arrays never carry `.mdly` paths.
 */
export async function executeSidecars(
	sidecarOps: NonNullable<SyncPlan["sidecarOps"]>,
	deps: ExecuteSidecarsDeps,
): Promise<void> {
	const {
		backend,
		fs,
		workspacePath,
		workspaceId,
		deviceId,
		now,
		remoteByPath,
		nextSidecars,
		result,
		tick,
	} = deps;

	function statFor(hash: string, mtime?: number, size?: number): FileState {
		return { hash, lastSyncedAt: now, mtime, size };
	}

	async function ensureParentDir(path: string) {
		const slash = path.lastIndexOf("/");
		if (slash > 0)
			await fs.ensureDir(`${workspacePath}/${path.slice(0, slash)}`);
	}

	/** Pushes one sidecar; false means "recorded as failed, keep going". */
	async function pushSidecar(
		path: string,
		hash: string,
		content: string,
		mtime?: number,
		size?: number,
	): Promise<boolean> {
		try {
			await backend.pushFile({
				workspaceId,
				path,
				contentHash: hash,
				content,
				deviceId,
			});
		} catch (error) {
			// Same isolation as the note push loop: record, continue, and
			// still write state at the end so all other progress is durable.
			const info = failureInfo(error);
			result.failedFiles.push({
				path,
				permanent: isPermanentFailure(error),
				kind: "sidecar",
				...info,
			});
			return false;
		}
		nextSidecars[path] = statFor(hash, mtime, size);
		return true;
	}

	for (const op of sidecarOps.toPush) {
		if (await pushSidecar(op.path, op.hash, op.content, op.mtime, op.size)) {
			result.sidecarsPushed++;
		}
		tick(op.path, "push");
	}

	for (const op of sidecarOps.toPull) {
		const remote = remoteByPath.get(op.path);
		const content = remote && !remote.deleted ? remote.content : op.content;
		const hash = remote && !remote.deleted ? remote.contentHash : op.hash;
		await ensureParentDir(op.path);
		await fs.writeFile(`${workspacePath}/${op.path}`, content);
		nextSidecars[op.path] = statFor(hash);
		result.sidecarsPulled++;
		tick(op.path, "pull");
	}

	for (const op of sidecarOps.merged) {
		await ensureParentDir(op.path);
		await fs.writeFile(`${workspacePath}/${op.path}`, op.content);
		if (await pushSidecar(op.path, op.hash, op.content)) {
			result.sidecarsMerged++;
		}
		tick(op.path, "pull");
	}
}

/** HTTP 413 means the server can never store this content — do not retry it. */
export function isPermanentFailure(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"status" in error &&
		(error as { status?: unknown }).status === 413
	);
}

function failureInfo(error: unknown): { code?: string; message: string } {
	if (typeof error === "object" && error !== null) {
		const record = error as { code?: unknown; message?: unknown };
		return {
			code: typeof record.code === "string" ? record.code : undefined,
			message:
				typeof record.message === "string" ? record.message : String(error),
		};
	}
	return { message: String(error) };
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
		sidecarsPushed: 0,
		sidecarsPulled: 0,
		sidecarsMerged: 0,
		failedFiles: [],
	};
	const nextFiles: Record<string, FileState> = { ...state.files };
	const nextRejected: Record<string, RejectedFile> = {
		...(state.rejectedFiles ?? {}),
	};
	const prevAssets = state.assets ?? {};
	const nextAssets: Record<string, FileState> = { ...prevAssets };
	// Sidecar baseline accumulator (Round 4): carried forward from state so
	// paths untouched this run keep their entries, and persisted by every
	// writeState() checkpoint below. Declared here — not at the sidecar
	// block — because writeState() runs before that block is reached.
	const nextSidecars: Record<string, FileState> = {
		...(state.sidecars ?? {}),
	};
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
		try {
			await pushLocal(op.path, op.hash, op.content, op.mtime, op.size);
		} catch (error) {
			// One file's failure must never abort the run: record it,
			// continue the loop, and still write state at the end so all
			// other progress is durable.
			const info = failureInfo(error);
			if (isPermanentFailure(error)) {
				nextRejected[op.path] = {
					hash: op.hash,
					code: info.code,
					message: info.message,
					rejectedAt: now,
				};
				result.failedFiles.push({ path: op.path, permanent: true, ...info });
			} else {
				// Transient (5xx, network…): reported now, retried next run —
				// state keeps the old entry so the next plan re-pushes it.
				result.failedFiles.push({ path: op.path, permanent: false, ...info });
			}
			tick(op.path, "push");
			continue;
		}
		// A push that now succeeds clears a stale rejection (e.g. the file
		// was edited down to a storable size after an earlier refusal).
		if (nextRejected[op.path]) delete nextRejected[op.path];
		tick(op.path, "push");
	}

	// Withheld by plan() as known permanent rejections: not retried, but
	// reported every run — unsynced, never silent. Not ticked: they are not
	// work, and totalOps doesn't count them.
	for (const skipped of computed.skippedPushes ?? []) {
		result.failedFiles.push({
			path: skipped.path,
			permanent: true,
			code: skipped.code,
			message: skipped.message,
		});
	}

	// Durability checkpoint: everything pushed above is recorded BEFORE the
	// pull listing below. If that listing throws, the run still propagates
	// the error — but the next run resumes instead of re-pushing.
	await writeState();

	// Pulls + deletes + conflicts need remote content fresh at execute time
	// for correctness; re-fetch once rather than per file.
	const remoteFiles = await backend.getFiles(workspaceId, {
		includeDeleted: true,
	});
	// Same fence as plan(): execute-time lookups run against notes only, so
	// a sidecar row can never leak into pull/delete/conflict handling here.
	const remoteByPath = new Map(
		remoteFiles.filter((f) => !isSidecarPath(f.path)).map((f) => [f.path, f]),
	);

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

	// Durability checkpoint: pulled files are recorded before deletes and
	// assets run, for the same resume-instead-of-repeat reason as above.
	await writeState();

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

	// --- Sidecar execution (Round 4) ---
	// Runs after conflicts, before assets. Sidecar lookups run against the
	// allowlisted rows of the same fresh fetch above — never the note map,
	// so the fence holds at execute time too. Still no delete path, and
	// `.mdly` never enters conflicts.
	const sidecarRemoteByPath = new Map(
		remoteFiles
			.filter((f) => isSyncedSidecarPath(f.path))
			.map((f) => [f.path, f]),
	);
	await executeSidecars(computed.sidecarOps ?? { toPush: [], toPull: [], merged: [] }, {
		backend,
		fs,
		workspacePath,
		workspaceId,
		deviceId,
		now,
		remoteByPath: sidecarRemoteByPath,
		nextSidecars,
		result,
		tick,
	});

	// Durability checkpoint: sidecar pushes/pulls/merges are recorded
	// before assets run, for the same resume-instead-of-repeat reason as
	// the file checkpoints above.
	await writeState();

	// --- Asset execution ---
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

	await writeState();
	throttle.flush({ phase: "done", done: total, total });
	return result;

	/**
	 * Persists everything recorded so far: files, assets, sidecars, and
	 * rejections (minus entries pruned for locally-deleted paths). Called
	 * at checkpoints and at the end, so a failure anywhere still leaves
	 * durable progress. `sidecars` is written only when non-empty, so runs
	 * without sidecars write byte-identical state to before — and the next
	 * run reuses it as the planSidecars() baseline.
	 * `rejectedFiles` is written only when non-empty, so runs without
	 * rejections write byte-identical state to before.
	 */
	async function writeState(): Promise<void> {
		for (const pruned of computed.prunedRejected ?? []) {
			delete nextRejected[pruned];
		}
		await writeSyncState(fs, workspacePath, {
			lastSyncedAt: now,
			files: nextFiles,
			assets: nextAssets,
			...(Object.keys(nextSidecars).length > 0
				? { sidecars: nextSidecars }
				: {}),
			...(Object.keys(nextRejected).length > 0
				? { rejectedFiles: nextRejected }
				: {}),
		});
	}
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
