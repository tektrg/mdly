/**
 * Desktop wiring for Phase 1 Cloud Sync (charter rules R19-R30), shaped like
 * `docHistoryWiring.ts` — pulled out of `main.ts` so this is unit testable
 * without a real Electron app (matching `fileDiscovery.ts`/`docImport.ts`/
 * `comments.ts`'s pattern).
 *
 * This module owns a SECOND, independent whole-workspace chokidar watcher
 * per opted-in workspace (R19), separate from the existing single-active-file
 * watcher (`desktop:watch-path` in main.ts). It never reimplements sync
 * logic: every push/pull goes through the untouched `sync()` from
 * `@hubble.md/sync`, fed a `FileSystem` decorator that (a) records every
 * pulled write's hash into the SAME `SelfWriteEchoTracker` instance the
 * active-file watcher already uses, so a cloud pull is never mistaken for an
 * external doc-history edit (R21), and (b) routes every pulled deletion
 * through `recordDeleteHistory` — the identical bookkeeping a user-initiated
 * delete already goes through (R22).
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { SyncBackend } from "@hubble.md/sync";
import {
	type CloudSyncConfig,
	readConfigOrDefault,
	sync as runSync,
	type FileSystem as SyncFileSystem,
	writeCloudSyncConfig,
} from "@hubble.md/sync";
import {
	createNodeFileSystem,
	WorkspaceTraversalLimitError,
} from "@hubble.md/sync/node";
import {
	CloudflareResponseError,
	createCloudflareBackend,
	createCloudflareSubscriber,
	deleteWorkspace as deleteRemoteWorkspace,
	type Subscriber,
} from "@mdly/cloudflare-client";
import type { KeychainCredentialStore } from "@mdly/cloudflare-client/keychain";
import { SHARED_CLOUD_SYNC_ACCOUNT } from "@mdly/cloudflare-client/keychain";
import { createNodeWebSocketFactory } from "@mdly/cloudflare-client/node-ws";
import { contentHash, isVersionableMarkdownPath } from "@mdly/doc-history";
import chokidar, { type FSWatcher } from "chokidar";
import {
	recordDeleteHistory,
	type SelfWriteEchoTracker,
} from "./docHistoryWiring";

export { SHARED_CLOUD_SYNC_ACCOUNT };
export type { KeychainCredentialStore };

/** Every state the D5 settings switch / sync-status indicator can show (R24, R26, R29, R30). */
export type CloudSyncStatus =
	| "off"
	| "connecting"
	| "syncing"
	| "idle"
	| "error"
	| "needs-reauth"
	| "workspace-unavailable"
	| "workspace-too-large";

export type CloudSyncStatusListener = (
	status: CloudSyncStatus,
	detail: string | null,
) => void;

export interface CloudSyncWorkspaceState {
	backgroundSync: boolean;
	status: CloudSyncStatus;
	workspaceId: string | null;
	deploymentUrl: string | null;
	detail: string | null;
	/** The EFFECTIVE never-synced folder-name list (config value if set, else `DEFAULT_CLOUD_SYNC_EXCLUDED_DIR_NAMES`) — what the settings textarea shows and what the running watcher actually prunes. */
	excludedFolders: string[];
}

/**
 * Injected dependencies (R21's whole point: the caller passes in the SAME
 * `SelfWriteEchoTracker`/`grantedRoots` `main.ts` already threads through
 * `docHistoryWiring.ts`'s functions — this module never constructs its own).
 * The three `create*` overrides exist purely for tests: default to the real
 * Cloudflare backend/subscriber/chokidar watcher.
 */
export interface CloudSyncWiringDeps {
	echoTracker: SelfWriteEchoTracker;
	grantedRoots: Iterable<string>;
	keychain: KeychainCredentialStore;
	debounceMs?: number;
	createBackend?: (opts: {
		deploymentUrl: string;
		token: string;
	}) => SyncBackend;
	createSubscriber?: (opts: {
		deploymentUrl: string;
		token: string;
	}) => Subscriber;
	createWatcher?: (
		workspaceRoot: string,
		excludedFolders: readonly string[],
	) => FSWatcher;
	/**
	 * Deletes a workspace's cloud copy (R36). Not a `SyncBackend` method — same
	 * reasoning as `createBackend` not covering `listWorkspaces` — so it's its
	 * own injection point, defaulting to the real
	 * `@mdly/cloudflare-client` `deleteWorkspace` call. Tests override this to
	 * avoid a real network call and to simulate failure (offline, rotated
	 * password) for the honesty-contract coverage below.
	 */
	deleteWorkspaceRemote?: (opts: {
		deploymentUrl: string;
		token: string;
		workspaceId: string;
	}) => Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 250;

/**
 * Caps how many files/folders one sync walk visits before it gives up with a
 * visible `workspace-too-large` status instead of silently walking (and
 * re-walking, on every debounced fs event) an unbounded tree. Comfortably
 * above any workspace `effectiveExcludedFolders` already keeps in bounds —
 * this is a backstop for the next pathological workspace, not a normal limit.
 */
const SYNC_MAX_ENTRIES = 200_000;

/**
 * The built-in never-synced folder names (R19) — `.mdly` alongside the four
 * dirs the plan names, since Phase 1 never syncs sidecars (D9/R18) and a
 * `.mdly` write must never trigger a sync cycle. `.claude` joins them because
 * agent worktrees living there hold tens of thousands of files that are never
 * workspace content; recursively watching one starves the Electron main
 * process's event loop and the app never paints.
 *
 * Single source of truth for the list: `PRUNED_DIR_NAMES` is derived from it,
 * and a workspace's `cloudSync.excludedFolders` overrides it wholesale.
 */
export const DEFAULT_CLOUD_SYNC_EXCLUDED_DIR_NAMES: readonly string[] = [
	".git",
	"node_modules",
	"dist",
	".dev-electron",
	".hubble",
	".mdly",
	".claude",
];

const PRUNED_DIR_NAMES = new Set(DEFAULT_CLOUD_SYNC_EXCLUDED_DIR_NAMES);

/**
 * The effective never-synced folder names for one workspace: its configured
 * list when present, otherwise the built-in defaults. An ABSENT config value
 * means "use the defaults" (not "exclude nothing"), so configs written before
 * the setting existed keep their protection and the defaults can grow later.
 */
export function effectiveExcludedFolders(
	config: { excludedFolders?: readonly string[] } | null | undefined,
): readonly string[] {
	return config?.excludedFolders ?? DEFAULT_CLOUD_SYNC_EXCLUDED_DIR_NAMES;
}

/** Exported for direct unit testing of the prune list (R19) without needing a real chokidar watcher. `excludedNames` defaults to the built-in list, so existing two-argument callers are unaffected. */
export function isPrunedCloudSyncPath(
	candidatePath: string,
	workspaceRoot: string,
	excludedNames: Iterable<string> = PRUNED_DIR_NAMES,
): boolean {
	const relative = path.relative(workspaceRoot, candidatePath);
	if (
		relative === "" ||
		relative.startsWith("..") ||
		path.isAbsolute(relative)
	) {
		return false;
	}
	const excluded =
		excludedNames instanceof Set ? excludedNames : new Set(excludedNames);
	return relative.split(/[\\/]+/).some((segment) => excluded.has(segment));
}

function defaultCreateBackend(opts: {
	deploymentUrl: string;
	token: string;
}): SyncBackend {
	return createCloudflareBackend({
		baseUrl: opts.deploymentUrl,
		auth: { kind: "bearer", token: opts.token },
	});
}

function defaultCreateSubscriber(opts: {
	deploymentUrl: string;
	token: string;
}): Subscriber {
	return createCloudflareSubscriber({
		baseUrl: opts.deploymentUrl,
		auth: { kind: "bearer", token: opts.token },
		webSocketFactory: createNodeWebSocketFactory(),
	});
}

function defaultCreateWatcher(
	workspaceRoot: string,
	excludedFolders: readonly string[],
): FSWatcher {
	// The Set is built once per watcher rather than once per candidate path:
	// chokidar calls `ignored` for every entry it walks, and the workspaces this
	// setting exists for have hundreds of thousands of them.
	const excluded = new Set(excludedFolders);
	return chokidar.watch(workspaceRoot, {
		ignoreInitial: true,
		ignored: (candidatePath: string) =>
			isPrunedCloudSyncPath(candidatePath, workspaceRoot, excluded),
	});
}

function defaultDeleteWorkspaceRemote(opts: {
	deploymentUrl: string;
	token: string;
	workspaceId: string;
}): Promise<void> {
	return deleteRemoteWorkspace({
		baseUrl: opts.deploymentUrl,
		auth: { kind: "bearer", token: opts.token },
		workspaceId: opts.workspaceId,
	});
}

function isEnoentError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

function classifyError(error: unknown): {
	status: CloudSyncStatus;
	detail: string;
} {
	if (
		error instanceof CloudflareResponseError &&
		(error.status === 401 || error.status === 403)
	) {
		return {
			status: "needs-reauth",
			detail:
				"Cloud Sync password was rejected — re-enter it in Settings to reconnect.",
		};
	}
	if (error instanceof WorkspaceTraversalLimitError) {
		return {
			status: "workspace-too-large",
			detail: `This workspace has more than ${error.limit.toLocaleString()} files/folders to sync — exclude some folders in Cloud Sync settings to continue.`,
		};
	}
	if (isEnoentError(error)) {
		return {
			status: "workspace-unavailable",
			detail: "This workspace's folder is no longer available on disk.",
		};
	}
	return {
		status: "error",
		detail: error instanceof Error ? error.message : String(error),
	};
}

/**
 * Wraps the real Node filesystem so every write `sync()` performs during a
 * PULL is echo-tracked (R21) and every delete it performs goes through the
 * same delete-history bookkeeping a user-initiated delete already uses
 * (R22). `sync()` itself is never modified — this is purely a decorator
 * around the `FileSystem` it's handed.
 */
function createCloudAwareFileSystem(
	base: SyncFileSystem,
	deps: Pick<CloudSyncWiringDeps, "echoTracker" | "grantedRoots">,
): SyncFileSystem {
	return {
		...base,
		async writeFile(filePath, content) {
			const absolutePath = path.resolve(filePath);
			if (isVersionableMarkdownPath(absolutePath)) {
				const hash = await contentHash(new TextEncoder().encode(content));
				deps.echoTracker.record(absolutePath, hash);
			}
			await base.writeFile(filePath, content);
		},
		async deleteFile(filePath) {
			const absolutePath = path.resolve(filePath);
			await base.deleteFile(filePath);
			await recordDeleteHistory({
				absoluteFilePath: absolutePath,
				grantedRoots: deps.grantedRoots,
			});
		},
	};
}

interface RunningCloudSync {
	watcher: FSWatcher;
	subscriber: Subscriber;
	unsubscribeFiles: () => void;
	status: CloudSyncStatus;
	detail: string | null;
	/** Set once, from the config read when this handle was created — carried on the handle itself (rather than threaded back in by every caller) so the idempotent "already running" return path in `startCloudSyncWatcherIfEnabled` reports the same `workspaceId`/`deploymentUrl` as a fresh start would. */
	workspaceId: string | null;
	deploymentUrl: string | null;
	/** The effective list this handle's live watcher was built with — `setCloudSyncExcludedFolders` restarts the watcher so this never drifts from the config. */
	excludedFolders: readonly string[];
	debounceTimer: ReturnType<typeof setTimeout> | null;
	running: boolean;
	pending: boolean;
	disposed: boolean;
}

const activeSyncs = new Map<string, RunningCloudSync>();
const statusListeners = new Map<string, Set<CloudSyncStatusListener>>();

function notifyStatus(
	workspaceRoot: string,
	status: CloudSyncStatus,
	detail: string | null,
) {
	for (const listener of statusListeners.get(workspaceRoot) ?? []) {
		try {
			listener(status, detail);
		} catch {
			// A listener's own error must never break sync (mirrors docHistoryWiring's "never throws" contract).
		}
	}
}

function setStatus(
	workspaceRoot: string,
	handle: RunningCloudSync,
	status: CloudSyncStatus,
	detail: string | null = null,
) {
	handle.status = status;
	handle.detail = detail;
	notifyStatus(workspaceRoot, status, detail);
}

/** Subscribes to status changes for one workspace. Survives across enable/disable cycles — unlike the ephemeral runtime handle, this registry is never torn down by `stopCloudSyncForWorkspace` (R29: independent per-workspace, R30: callers register once per window). */
export function onCloudSyncStatusChange(
	workspaceRoot: string,
	listener: CloudSyncStatusListener,
): () => void {
	let set = statusListeners.get(workspaceRoot);
	if (!set) {
		set = new Set();
		statusListeners.set(workspaceRoot, set);
	}
	set.add(listener);
	return () => {
		set?.delete(listener);
	};
}

export function getCloudSyncStatus(workspaceRoot: string): CloudSyncStatus {
	return activeSyncs.get(workspaceRoot)?.status ?? "off";
}

/** True only for a workspace currently running a live watcher+subscriber — used by tests to assert R25's "no leaked duplicate" property. False for a torn-down `workspace-unavailable` handle kept around only so its status stays visible (R24). */
export function isCloudSyncRunning(workspaceRoot: string): boolean {
	const handle = activeSyncs.get(workspaceRoot);
	return handle !== undefined && !handle.disposed;
}

export function activeCloudSyncWorkspaceCount(): number {
	return activeSyncs.size;
}

async function runOnce(
	workspaceRoot: string,
	handle: RunningCloudSync,
	backend: SyncBackend,
	cloudFs: SyncFileSystem,
) {
	if (handle.disposed) return;
	if (handle.running) {
		handle.pending = true;
		return;
	}
	handle.running = true;
	try {
		// Reentrant drain loop — mirrors packages/cli's createSyncScheduler exactly (a trigger arriving mid-run re-runs once more instead of being dropped).
		while (true) {
			if (handle.disposed) return;
			setStatus(workspaceRoot, handle, "syncing");
			try {
				await runSync(backend, cloudFs, workspaceRoot);
				if (handle.disposed) return;
				setStatus(workspaceRoot, handle, "idle");
			} catch (error) {
				if (handle.disposed) return;
				const { status, detail } = classifyError(error);
				setStatus(workspaceRoot, handle, status, detail);
				if (
					status === "workspace-unavailable" ||
					status === "workspace-too-large"
				) {
					// Tear down the live watcher/subscriber (never retry silently
					// forever, R24) but keep the handle in `activeSyncs` so the
					// error stays visible via `getCloudSyncStatus` rather than
					// quietly resetting to "off" the instant this fires. A
					// too-large workspace doesn't shrink on its own either — re-walking
					// it on every debounced fs event would just repeat the same
					// failure forever.
					await teardownRuntimeKeepingStatus(handle);
					return;
				}
			}
			if (!handle.pending) break;
			handle.pending = false;
		}
	} finally {
		handle.running = false;
	}
}

function scheduleSync(
	workspaceRoot: string,
	handle: RunningCloudSync,
	backend: SyncBackend,
	cloudFs: SyncFileSystem,
	debounceMs: number,
) {
	if (handle.disposed) return;
	if (handle.debounceTimer) clearTimeout(handle.debounceTimer);
	handle.debounceTimer = setTimeout(() => {
		handle.debounceTimer = null;
		void runOnce(workspaceRoot, handle, backend, cloudFs);
	}, debounceMs);
}

/**
 * Starts (or, if already running, no-ops and returns the existing state for)
 * this workspace's watcher+subscriber pair, reading `.hubble/config.json`'s
 * `cloudSync.backgroundSync` to decide whether to actually start anything
 * (R26). Idempotent by construction (R25): a second call for a workspace
 * already running never creates a second watcher or a second subscriber.
 */
export async function startCloudSyncWatcherIfEnabled(
	workspaceRoot: string,
	deps: CloudSyncWiringDeps,
): Promise<CloudSyncWorkspaceState> {
	const existing = activeSyncs.get(workspaceRoot);
	if (existing) return readState(existing);

	const config = await readConfigOrDefault(
		createNodeFileSystem(),
		workspaceRoot,
	);
	const cloudSync = config.cloudSync as CloudSyncConfig | undefined;
	const excludedFolders = effectiveExcludedFolders(cloudSync);
	if (!cloudSync || !cloudSync.backgroundSync) {
		return {
			backgroundSync: false,
			status: "off",
			workspaceId: cloudSync?.workspaceId ?? null,
			deploymentUrl: cloudSync?.deploymentUrl ?? null,
			detail: null,
			excludedFolders: [...excludedFolders],
		};
	}

	const token = await deps.keychain.getPassword(SHARED_CLOUD_SYNC_ACCOUNT);
	const handle: RunningCloudSync = {
		watcher: null as unknown as FSWatcher,
		subscriber: null as unknown as Subscriber,
		unsubscribeFiles: () => {},
		status: "connecting",
		detail: null,
		workspaceId: cloudSync.workspaceId,
		deploymentUrl: cloudSync.deploymentUrl,
		excludedFolders,
		debounceTimer: null,
		running: false,
		pending: false,
		disposed: false,
	};
	activeSyncs.set(workspaceRoot, handle);
	notifyStatus(workspaceRoot, "connecting", null);

	if (!token) {
		activeSyncs.delete(workspaceRoot);
		return {
			backgroundSync: true,
			status: "needs-reauth",
			workspaceId: cloudSync.workspaceId,
			deploymentUrl: cloudSync.deploymentUrl,
			detail: "No Cloud Sync password stored in Keychain yet.",
			excludedFolders: [...excludedFolders],
		};
	}

	const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const createBackend = deps.createBackend ?? defaultCreateBackend;
	const createSubscriber = deps.createSubscriber ?? defaultCreateSubscriber;
	const createWatcher = deps.createWatcher ?? defaultCreateWatcher;

	const backend = createBackend({
		deploymentUrl: cloudSync.deploymentUrl,
		token,
	});
	const cloudFs = createCloudAwareFileSystem(
		createNodeFileSystem({
			// The sync walk must skip the SAME folders the watcher already skips
			// (`excludedFolders` above) — otherwise it walks (and re-walks, on
			// every debounced fs event) folders like `.claude` that a workspace's
			// own git worktrees can churn thousands of entries deep, which is both
			// slow and a source of "file deleted mid-walk" races.
			excludedFolders,
			maxEntries: SYNC_MAX_ENTRIES,
		}),
		deps,
	);

	const subscriber = createSubscriber({
		deploymentUrl: cloudSync.deploymentUrl,
		token,
	});
	handle.subscriber = subscriber;
	// A remote broadcast resyncs promptly with no debounce on this leg — the
	// 250ms debounce (R19) applies to LOCAL fs events, which can arrive in
	// bursts; a remote push is already one discrete event.
	handle.unsubscribeFiles = subscriber.onFilesChanged(
		cloudSync.workspaceId,
		() => scheduleSync(workspaceRoot, handle, backend, cloudFs, 0),
		(error) => {
			const { status, detail } = classifyError(error);
			setStatus(workspaceRoot, handle, status, detail);
		},
	);

	const watcher = createWatcher(workspaceRoot, excludedFolders);
	handle.watcher = watcher;
	const onFsEvent = () =>
		scheduleSync(workspaceRoot, handle, backend, cloudFs, debounceMs);
	watcher.on("add", onFsEvent);
	watcher.on("change", onFsEvent);
	watcher.on("unlink", onFsEvent);
	watcher.on("addDir", onFsEvent);
	watcher.on("unlinkDir", onFsEvent);
	watcher.on("error", (error) => {
		const { status, detail } = classifyError(error);
		setStatus(workspaceRoot, handle, status, detail);
		if (status === "workspace-unavailable") {
			void teardownRuntimeKeepingStatus(handle);
		}
	});

	await runOnce(workspaceRoot, handle, backend, cloudFs);
	return readState(activeSyncs.get(workspaceRoot) ?? handle);
}

function readState(handle: RunningCloudSync): CloudSyncWorkspaceState {
	return {
		backgroundSync: true,
		status: handle.status,
		workspaceId: handle.workspaceId,
		deploymentUrl: handle.deploymentUrl,
		detail: handle.detail,
		excludedFolders: [...handle.excludedFolders],
	};
}

/** Closes the watcher/subscriber/timer without removing the handle from `activeSyncs` — used only for the `workspace-unavailable` case (R24) so `getCloudSyncStatus`/`onCloudSyncStatusChange` keep reporting the error instead of silently resetting to "off". Idempotent. */
async function teardownRuntimeKeepingStatus(
	handle: RunningCloudSync,
): Promise<void> {
	if (handle.disposed) return;
	handle.disposed = true;
	if (handle.debounceTimer) clearTimeout(handle.debounceTimer);
	try {
		handle.unsubscribeFiles();
	} catch {
		// best-effort teardown
	}
	await handle.subscriber?.close().catch(() => {});
	await handle.watcher?.close().catch(() => {});
}

/** Stops and fully tears down this workspace's watcher+subscriber, if running, and removes it from the active-sync registry so a later `startCloudSyncWatcherIfEnabled` starts fresh. Safe to call on a workspace that isn't running. Never leaves a dangling watcher/subscription behind (R25). */
export async function stopCloudSyncForWorkspace(
	workspaceRoot: string,
): Promise<void> {
	const handle = activeSyncs.get(workspaceRoot);
	if (!handle) return;
	activeSyncs.delete(workspaceRoot);
	await teardownRuntimeKeepingStatus(handle);
}

/** Called on app quit / test teardown so no test (or app shutdown) leaks a live watcher/subscription across runs. */
export async function stopAllCloudSync(): Promise<void> {
	await Promise.all(
		[...activeSyncs.keys()].map((root) => stopCloudSyncForWorkspace(root)),
	);
}

export interface EnableCloudSyncOptions {
	workspaceRoot: string;
	workspaceName: string;
	deploymentUrl: string;
	/** The shared Cloud Sync password. Required only the first time (no credential yet in the Keychain) or when rotating it; omit to reuse whatever is already stored. */
	password?: string;
}

/**
 * Turns Cloud Sync ON for one workspace (R26/R27's opt-in half): stores the
 * password in the Keychain if a fresh one was supplied (R20 — never in
 * `.hubble/config.json`), then makes the Worker actually know about this
 * workspace by calling `getWorkspace`/`createWorkspace` BEFORE marking it
 * enabled (R28 — flipping local config alone is not sufficient), persists
 * `cloudSync.backgroundSync = true`, and starts the watcher.
 */
export async function enableCloudSyncForWorkspace(
	options: EnableCloudSyncOptions,
	deps: CloudSyncWiringDeps,
): Promise<CloudSyncWorkspaceState> {
	if (options.password) {
		await deps.keychain.setPassword(
			SHARED_CLOUD_SYNC_ACCOUNT,
			options.password,
		);
	}
	const token = await deps.keychain.getPassword(SHARED_CLOUD_SYNC_ACCOUNT);
	if (!token) {
		throw new Error(
			"No Cloud Sync password stored — enter it once to enable Cloud Sync.",
		);
	}

	const createBackend = deps.createBackend ?? defaultCreateBackend;
	const backend = createBackend({
		deploymentUrl: options.deploymentUrl,
		token,
	});

	// R28: the Worker must actually know about this workspace before we mark
	// it enabled locally.
	const workspaceId =
		(await backend.getWorkspace(options.workspaceName)) ??
		(await backend.createWorkspace(options.workspaceName));

	const fsAdapter = createNodeFileSystem();
	const existing = await readConfigOrDefault(fsAdapter, options.workspaceRoot);
	await writeCloudSyncConfig(fsAdapter, options.workspaceRoot, {
		provider: "cloudflare",
		deploymentUrl: options.deploymentUrl,
		workspaceId,
		deviceId: existing.cloudSync?.deviceId ?? crypto.randomUUID(),
		backgroundSync: true,
		// Carried over rather than rebuilt: re-enabling must not silently drop the
		// workspace's never-synced folder list. Left undefined when unset, so the
		// key stays absent from the file and the defaults keep applying.
		excludedFolders: existing.cloudSync?.excludedFolders,
	});

	return startCloudSyncWatcherIfEnabled(options.workspaceRoot, deps);
}

export interface DisableCloudSyncResult {
	/** True only when the Worker confirmed this workspace's cloud copy (files/assets/versions, and the list-workspaces entry) was actually removed. False means the local toggle is off but the cloud copy is UNPROVEN removed — never reported as deleted when it wasn't (the honesty requirement). */
	cloudCopyDeleted: boolean;
}

const CLOUD_COPY_NOT_DELETED_DETAIL =
	"Cloud sync is off, but the cloud copy has not been removed yet — this will retry automatically.";

/**
 * Attempts to delete `cloudSync`'s workspace from the Cloudflare backend.
 * Never throws — every failure mode (no credential, offline, a rotated
 * password producing a 401) is caught and reported as `false` rather than
 * bubbling up, because a failed delete must never block turning local sync
 * off (R27 already requires "off" to take effect immediately).
 */
async function attemptRemoteWorkspaceDelete(
	cloudSync: CloudSyncConfig,
	deps: CloudSyncWiringDeps,
): Promise<boolean> {
	try {
		const token = await deps.keychain.getPassword(SHARED_CLOUD_SYNC_ACCOUNT);
		if (!token) return false; // no credential — cannot prove the delete happened.
		const deleteRemote =
			deps.deleteWorkspaceRemote ?? defaultDeleteWorkspaceRemote;
		await deleteRemote({
			deploymentUrl: cloudSync.deploymentUrl,
			token,
			workspaceId: cloudSync.workspaceId,
		});
		return true;
	} catch (error) {
		console.error(
			`[cloud-sync] failed to delete cloud copy for workspace "${cloudSync.workspaceId}":`,
			error,
		);
		return false;
	}
}

/**
 * Turns Cloud Sync OFF for one workspace (R27) AND deletes its Cloudflare
 * copy (R36 — the charter gap this closes): "off" means gone, not just
 * "stopped pushing." Persists `backgroundSync = false` and stops the watcher
 * FIRST, unconditionally — that half of R27 must hold even if the network is
 * down. The remote delete is then attempted; if it fails, `pendingRemoteDelete`
 * is persisted so `retryPendingCloudSyncDeletions` can finish the job on a
 * later launch, and the returned/reported state says plainly that the cloud
 * copy is not gone yet — this function and its callers never claim "deleted"
 * when nothing was. Never touches another workspace's config (R26).
 */
export async function disableCloudSyncForWorkspace(
	workspaceRoot: string,
	deps: CloudSyncWiringDeps,
): Promise<DisableCloudSyncResult> {
	const fsAdapter = createNodeFileSystem();
	const existing = await readConfigOrDefault(fsAdapter, workspaceRoot);
	const cloudSync = existing.cloudSync as CloudSyncConfig | undefined;

	await stopCloudSyncForWorkspace(workspaceRoot);

	if (!cloudSync) {
		// Never enabled (or already fully torn down) — there is no cloud copy
		// to remove, so there is nothing dishonest about reporting "deleted".
		return { cloudCopyDeleted: true };
	}

	const cloudCopyDeleted = await attemptRemoteWorkspaceDelete(cloudSync, deps);
	await writeCloudSyncConfig(fsAdapter, workspaceRoot, {
		...cloudSync,
		backgroundSync: false,
		pendingRemoteDelete: cloudCopyDeleted ? undefined : true,
	});

	notifyStatus(
		workspaceRoot,
		cloudCopyDeleted ? "off" : "error",
		cloudCopyDeleted ? null : CLOUD_COPY_NOT_DELETED_DETAIL,
	);

	return { cloudCopyDeleted };
}

/**
 * Turns a raw, textarea-shaped list into exactly what gets persisted: entries
 * trimmed, blanks dropped, duplicates removed, original order kept. Throws a
 * user-facing message — and writes nothing — when an entry is a path rather
 * than a folder name, because entries are matched at any depth and a separator
 * could therefore never match anything.
 */
export function normalizeExcludedFolders(folders: readonly string[]): string[] {
	const normalized: string[] = [];
	for (const raw of folders) {
		const name = raw.trim();
		if (name === "") continue;
		if (name.includes("/") || name.includes("\\")) {
			throw new Error(
				`"${name}" looks like a path. List folder NAMES only — each name is matched at any depth inside the workspace.`,
			);
		}
		if (!normalized.includes(name)) normalized.push(name);
	}
	return normalized;
}

/**
 * Persists this workspace's never-synced folder names and makes them take
 * effect immediately: if a watcher is live for this root it is torn down and
 * restarted through the SAME `startCloudSyncWatcherIfEnabled` path launch uses
 * (never a second, parallel start), so what chokidar prunes always matches
 * what the config says and R25's "no duplicate watcher" still holds. Input is
 * validated before the config file is touched, so a rejected entry never
 * leaves a half-written setting behind.
 */
export async function setCloudSyncExcludedFolders(
	workspaceRoot: string,
	folders: readonly string[],
	deps: CloudSyncWiringDeps,
): Promise<CloudSyncWorkspaceState> {
	const normalized = normalizeExcludedFolders(folders);
	const fsAdapter = createNodeFileSystem();
	const existing = await readConfigOrDefault(fsAdapter, workspaceRoot);
	const cloudSync = existing.cloudSync as CloudSyncConfig | undefined;
	if (!cloudSync) {
		// `cloudSync.excludedFolders` has nowhere to live until the rest of the
		// cloudSync record (workspace id, deployment URL, device id) exists, and
		// fabricating those would be worse than saying so plainly.
		throw new Error(
			"Turn Cloud Sync on for this workspace once before choosing which folders it never syncs.",
		);
	}
	await writeCloudSyncConfig(fsAdapter, workspaceRoot, {
		...cloudSync,
		excludedFolders: normalized,
	});

	if (isCloudSyncRunning(workspaceRoot)) {
		await stopCloudSyncForWorkspace(workspaceRoot);
		await startCloudSyncWatcherIfEnabled(workspaceRoot, deps);
	}
	return readCloudSyncWorkspaceState(workspaceRoot);
}

/**
 * Retries any workspace's cloud-copy deletion that failed earlier (offline,
 * a rotated password) — called alongside `resumeCloudSyncForGrantedRoots` on
 * app launch so "off" eventually catches up to "actually gone" without
 * requiring the user to remember to retry by hand. Errors for one root are
 * isolated and never abort retrying the rest.
 */
export async function retryPendingCloudSyncDeletions(
	roots: Iterable<string>,
	deps: CloudSyncWiringDeps,
): Promise<void> {
	const fsAdapter = createNodeFileSystem();
	await Promise.all(
		[...roots].map(async (root) => {
			try {
				const config = await readConfigOrDefault(fsAdapter, root);
				const cloudSync = config.cloudSync as CloudSyncConfig | undefined;
				if (!cloudSync?.pendingRemoteDelete) return;
				const cloudCopyDeleted = await attemptRemoteWorkspaceDelete(
					cloudSync,
					deps,
				);
				if (!cloudCopyDeleted) return;
				await writeCloudSyncConfig(fsAdapter, root, {
					...cloudSync,
					pendingRemoteDelete: undefined,
				});
				notifyStatus(root, "off", null);
			} catch (error) {
				console.error(
					`[cloud-sync] retry of pending cloud-copy delete failed for ${root}:`,
					error,
				);
			}
		}),
	);
}

/** Read-only state for the settings switch / status indicator (R27, R29) — reflects on-disk config plus (if running) live status, without starting or stopping anything. */
export async function readCloudSyncWorkspaceState(
	workspaceRoot: string,
): Promise<CloudSyncWorkspaceState> {
	const config = await readConfigOrDefault(
		createNodeFileSystem(),
		workspaceRoot,
	);
	const cloudSync = config.cloudSync as CloudSyncConfig | undefined;
	const running = activeSyncs.get(workspaceRoot);
	const fallbackStatus: CloudSyncStatus = cloudSync?.pendingRemoteDelete
		? "error"
		: cloudSync?.backgroundSync
			? "connecting"
			: "off";
	return {
		backgroundSync: cloudSync?.backgroundSync ?? false,
		status: running?.status ?? fallbackStatus,
		workspaceId: cloudSync?.workspaceId ?? null,
		deploymentUrl: cloudSync?.deploymentUrl ?? null,
		detail:
			running?.detail ??
			(cloudSync?.pendingRemoteDelete ? CLOUD_COPY_NOT_DELETED_DETAIL : null),
		excludedFolders: [...effectiveExcludedFolders(cloudSync)],
	};
}

/**
 * Resumes Cloud Sync on app launch (and whenever a new workspace root is
 * granted) for every root whose config already has `backgroundSync: true` —
 * so the opt-in genuinely "survives quitting and relaunching" (R27) rather
 * than just remembering a checkbox position that does nothing until the
 * user revisits Settings. Errors for one root (a missing folder, a stale
 * config) are isolated per-root and never abort resuming the rest.
 */
export async function resumeCloudSyncForGrantedRoots(
	grantedRoots: Iterable<string>,
	deps: CloudSyncWiringDeps,
): Promise<void> {
	await Promise.all(
		[...grantedRoots].map(async (root) => {
			try {
				await startCloudSyncWatcherIfEnabled(root, deps);
			} catch (error) {
				console.error(`[cloud-sync] failed to resume ${root}:`, error);
			}
		}),
	);
}

/** Exported for `main.ts`'s `desktop:write-workspace-config` fix (see main.ts) — reads the raw `.hubble/config.json` object without validating/stripping any key, so callers can preserve whatever they don't understand. */
export async function readRawWorkspaceConfigFile(
	workspaceRoot: string,
): Promise<Record<string, unknown>> {
	try {
		const raw = await fs.readFile(
			path.join(workspaceRoot, ".hubble", "config.json"),
			"utf8",
		);
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}
