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
	classifyExcludedTop,
	countSubtreeWithEarlyBail,
	execute as executeSyncPlan,
	type FolderSummaryEntry,
	isOverPendingThreshold,
	matchesExcludedPattern,
	normalizeExcludedEntries,
	type PendingFolder,
	plan as planSync,
	readConfigOrDefault,
	type FileSystem as SyncFileSystem,
	type SyncPlan,
	type SyncProgress,
	writeCloudSyncConfig,
} from "@hubble.md/sync";
import {
	createNodeFileSystem,
	WorkspaceDirectoryLimitError,
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
import {
	contentHash,
	historyRootFor,
	isVersionableMarkdownPath,
	resolvePathIndex,
} from "@mdly/doc-history";
import { createNodeFileSystem as createDocHistoryNodeFileSystem } from "@mdly/doc-history/node";
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
	/** Structured progress payload — undefined for statuses that carry no counts. Existing two-arg listeners keep working. */
	progress?: SyncProgress | null,
) => void;

export type CloudSyncProgressListener = (progress: SyncProgress) => void;

export interface CloudSyncWorkspaceState {
	backgroundSync: boolean;
	status: CloudSyncStatus;
	workspaceId: string | null;
	deploymentUrl: string | null;
	detail: string | null;
	/** The EFFECTIVE never-synced exclusion list (config value if set, else `DEFAULT_CLOUD_SYNC_EXCLUDED_DIR_NAMES`) — what the settings textarea shows and what the running watcher actually prunes. Bare names match at any depth; entries with a separator are anchored to the workspace root. */
	excludedFolders: string[];
	/** Folders held out of sync until approved (D-LW5). Empty when none pending. */
	pendingFolders: PendingFolder[];
	/** Latest structured sync progress, if a sync is or recently was running. */
	progress: SyncProgress | null;
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
	/**
	 * Fired with the ABSOLUTE note path after a sync run pulls or merges a
	 * comment log for it, so the open document view refreshes without
	 * waiting for a reopen. Optional so existing dep constructions keep
	 * compiling — without it a pulled comment just sits on disk until the
	 * note is reopened. `main.ts` maps it to the existing
	 * `desktop:comments-changed` channel (no new preload/renderer work).
	 */
	notifyCommentsChanged?: (absoluteNotePath: string) => void;
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
 * Caps how many DIRECTORIES one sync walk visits before it gives up with a
 * visible `workspace-too-large` status. Directories are what consume OS
 * watch handles — the old entries-only cap would NOT have fired for AptusFit
 * (~40k entries, 8,474 dirs), which is exactly the failure that froze the
 * app. Comfortably above any healthy workspace; a backstop, not a limit.
 */
const SYNC_MAX_DIRECTORIES = 20_000;

/**
 * The built-in never-synced folder names (R19) — `.mdly` alongside the four
 * dirs the plan names, since Phase 1 never syncs sidecars (D9/R18) and a
 * `.mdly` write must never trigger a sync cycle. `.claude` joins them because
 * agent worktrees living there hold tens of thousands of files that are never
 * workspace content; recursively watching one starves the Electron main
 * process's event loop and the app never paints.
 *
 * Reconsidered per review (D-LW1 is now real: nested-repo walk pruning,
 * `.git/info/exclude`, global ignores, pending holds) and deliberately KEPT:
 * the walk is protected four ways, but the chokidar WATCHER only understands
 * this flat list — its sync `ignored` callback cannot cheaply prune nested
 * repos per path, so dropping `.claude` here would re-expose the EMFILE
 * freeze on the watch leg even with the walk fully guarded. Cost: hand-written
 * notes directly under `.claude/` (e.g. briefs) don't sync unless the user
 * removes `.claude` from this list (opt-out preserved) or moves them out.
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

/** Exported for direct unit testing of the prune list (R19) without needing a real chokidar watcher. `excludedNames` defaults to the built-in list, so existing two-argument callers are unaffected. Bare names match at any depth; entries containing a separator are anchored to the workspace root (gitignore's own convention — a selection UI inherently produces paths). */
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
	const entries =
		excludedNames instanceof Set ? [...excludedNames] : [...excludedNames];
	return matchesExcludedPattern(relative.split(path.sep).join("/"), entries);
}

/**
 * The single named exception to the `.mdly` prune (Round 5): comment logs
 * and history index shards must be WATCHED so local edits to them trigger a
 * sync cycle, even though `.mdly` itself stays in
 * `DEFAULT_CLOUD_SYNC_EXCLUDED_DIR_NAMES` (that list is user-editable,
 * rendered in Settings, and fed to the sync walk — removing `.mdly` there
 * is not an option). Exactly one call site (`defaultCreateWatcher`
 * below) — never a second parallel exclusion list; two lists that can
 * drift is the known trap here.
 *
 * Mirrors the sync allowlist (`isSyncedSidecarPath` in `@hubble.md/sync`):
 * everything under `.mdly/comments/` plus the top-level
 * `.mdly/history/index*.jsonl` shards. Ancestor dirs (`.mdly` itself,
 * `.mdly/comments`, `.mdly/history`) return true so chokidar descends into
 * them instead of pruning the watched leaves. Revision blobs
 * (`.mdly/history/objects/**`) and everything else return false and fall
 * through to `isPrunedCloudSyncPath`.
 */
export function isWatchedSidecarPath(
	candidatePath: string,
	workspaceRoot: string,
): boolean {
	const relative = path.relative(workspaceRoot, candidatePath);
	if (
		relative === "" ||
		relative.startsWith("..") ||
		path.isAbsolute(relative)
	) {
		return false;
	}
	const posix = relative.split(path.sep).join("/");
	if (posix === ".mdly" || posix === ".mdly/comments" || posix === ".mdly/history") {
		return true;
	}
	const commentsPrefix = ".mdly/comments/";
	if (
		posix.startsWith(commentsPrefix) &&
		posix.length > commentsPrefix.length
	) {
		return true;
	}
	const historyPrefix = ".mdly/history/";
	if (posix.startsWith(historyPrefix)) {
		const rest = posix.slice(historyPrefix.length);
		// Top level only (`index*.jsonl`): no nested shards, no objects dir.
		if (!rest.includes("/")) return /^index[^/]*\.jsonl$/i.test(rest);
	}
	return false;
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
			isWatchedSidecarPath(candidatePath, workspaceRoot)
				? false
				: isPrunedCloudSyncPath(candidatePath, workspaceRoot, excluded),
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
	if (error instanceof WorkspaceDirectoryLimitError) {
		return {
			status: "workspace-too-large",
			detail: `This workspace has more than ${error.limit.toLocaleString()} folders to watch — exclude some folders in Cloud Sync settings to continue.`,
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
 * Filters walk results to provisionally-unvetted subtrees. `sync()` itself
 * is never modified — this is purely a `FileSystem` decorator, same shape as
 * `createCloudAwareFileSystem`. The walk still descends (bounded by the
 * entry/directory caps); the filter only decides eligibility, so a sync
 * firing mid-arrival pushes nothing from the new subtree.
 */
function createVettingFileSystem(
	base: SyncFileSystem,
	unvettedDirs: Set<string>,
): SyncFileSystem {
	function topOf(relativePath: string): string {
		const slash = relativePath.indexOf("/");
		return slash === -1 ? "" : relativePath.slice(0, slash);
	}
	return {
		...base,
		async listMarkdownFiles(dir) {
			const files = await base.listMarkdownFiles(dir);
			if (unvettedDirs.size === 0) return files;
			return files.filter((f) => !unvettedDirs.has(topOf(f.relativePath)));
		},
		async listAssetFiles(dir) {
			const files = await base.listAssetFiles(dir);
			if (unvettedDirs.size === 0) return files;
			return files.filter((f) => !unvettedDirs.has(topOf(f.relativePath)));
		},
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
	progress: SyncProgress | null;
	/** Set once, from the config read when this handle was created — carried on the handle itself (rather than threaded back in by every caller) so the idempotent "already running" return path in `startCloudSyncWatcherIfEnabled` reports the same `workspaceId`/`deploymentUrl` as a fresh start would. */
	workspaceId: string | null;
	deploymentUrl: string | null;
	/** The effective list this handle's live watcher was built with — `setCloudSyncExcludedFolders` restarts the watcher so this never drifts from the config. */
	excludedFolders: readonly string[];
	/** Pending folders snapshot at start time — surfaced in state so the main-window badge and Settings list render without another disk read. */
	pendingFolders: PendingFolder[];
	/** Approved top-level dirs snapshot — approval is durable, so the vet check never spontaneously re-holds these. */
	approvedFolders: string[];
	debounceTimer: ReturnType<typeof setTimeout> | null;
	/** Max-wait cap so a continuously-written tree still progresses instead of debouncing forever. */
	maxWaitTimer: ReturnType<typeof setTimeout> | null;
	/** Debounced re-scan for NEW over-threshold folders (a worktree arrives as thousands of addDir events, not one "folder added"). */
	pendingCheckTimer: ReturnType<typeof setTimeout> | null;
	/**
	 * Top-level dirs seen via `addDir` since start that no vet check has
	 * cleared yet. Their whole subtree is provisionally INELIGIBLE for sync
	 * (filtered from walk results) until a vet check holds or clears them —
	 * so a folder materializing for minutes can never be synced before the
	 * hold applies, no matter how the sync/vet timers interleave.
	 */
	unvettedDirs: Set<string>;
	/** Last `addDir`/file activity per unvetted top-level dir. */
	unvettedActivity: Map<string, number>;
	/** Last bounded count per unvetted top — release requires stability, not just quiet. */
	unvettedLastCount: Map<string, { files: number; dirs: number }>;
	/** Rapid file events per known top since vetting — a burst re-arms the hold (pause-resume backstop). */
	topBursts: Map<string, number>;
	/**
	 * Top-level names that existed when the watcher was built. A file event
	 * under a top NOT in here and NOT unvetted means `addDir` was missed or
	 * is still in flight (e.g. the dir landed during chokidar's initial
	 * scan) — mark it unvetted on the file event itself rather than
	 * trusting `addDir` delivery order.
	 */
	knownTops: Set<string>;
	running: boolean;
	/** Coalesced trigger count (was a plain boolean) — the unbounded drain loop re-ran full walks forever under constant writes; capped in runOnce. */
	pending: number;
	disposed: boolean;
	/** Live backend/fs for follow-up scheduling from vet checks (set once at start). */
	backend: SyncBackend | null;
	cloudFs: SyncFileSystem | null;
	deps: CloudSyncWiringDeps | null;
}

const activeSyncs = new Map<string, RunningCloudSync>();
const statusListeners = new Map<string, Set<CloudSyncStatusListener>>();
const progressListeners = new Map<string, Set<CloudSyncProgressListener>>();

/** Maximum re-runs of the drain loop per trigger burst — back-to-back full walks forever under constant agent-worktree writes is what kept the app hot. */
const MAX_DRAIN_ITERATIONS = 3;
/** Debounce max-wait: a continuously-written tree still syncs at least this often. */
const MAX_DEBOUNCE_WAIT_MS = 5000;
/** An unvetted dir is evaluated only after its arrival goes this quiet — a continuously-materializing checkout stays provisionally excluded until it stops churning. */
const VET_QUIET_MS = 1500;
/** Delay before the first vet check after a new dir is seen (coalesced, never reset by further events). */
const VET_DELAY_MS = 2000;
/**
 * Rapid file events on one already-vetted top that re-arm the provisional
 * hold (pause-resume backstop). Ordinary editing is tens of events; a
 * resumed checkout is thousands. Bounded leak before re-hold: this many files.
 */
const VET_BURST_REARM = 50;

function notifyStatus(
	workspaceRoot: string,
	status: CloudSyncStatus,
	detail: string | null,
	progress: SyncProgress | null = null,
) {
	for (const listener of statusListeners.get(workspaceRoot) ?? []) {
		try {
			listener(status, detail, progress);
		} catch {
			// A listener's own error must never break sync (mirrors docHistoryWiring's "never throws" contract).
		}
	}
}

function notifyProgress(workspaceRoot: string, progress: SyncProgress) {
	for (const listener of progressListeners.get(workspaceRoot) ?? []) {
		try {
			listener(progress);
		} catch {
			// Never break sync.
		}
	}
}

function setStatus(
	workspaceRoot: string,
	handle: RunningCloudSync,
	status: CloudSyncStatus,
	detail: string | null = null,
	progress: SyncProgress | null = null,
) {
	handle.status = status;
	handle.detail = detail;
	if (progress !== null) handle.progress = progress;
	notifyStatus(workspaceRoot, status, detail, handle.progress);
}

function setProgress(
	workspaceRoot: string,
	handle: RunningCloudSync,
	progress: SyncProgress,
) {
	handle.progress = progress;
	notifyProgress(workspaceRoot, progress);
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

/** Subscribes to structured sync progress for one workspace (indeterminate `scan` count-up, then a determinate bar once `plan()` returns — never a fake bar). */
export function onCloudSyncProgressChange(
	workspaceRoot: string,
	listener: CloudSyncProgressListener,
): () => void {
	let set = progressListeners.get(workspaceRoot);
	if (!set) {
		set = new Set();
		progressListeners.set(workspaceRoot, set);
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
		handle.pending += 1;
		return;
	}
	handle.running = true;
	try {
		// Reentrant drain loop, CAPPED: a trigger arriving mid-run re-runs
		// (never dropped), but at most MAX_DRAIN_ITERATIONS extra passes per
		// burst. The old unbounded `while (pending)` re-ran full walks
		// forever under constant agent-worktree writes — back-to-back 9s
		// walks that never exited. When the cap is hit with work still
		// pending, the signal is KEPT (never zeroed), an honest
		// still-catching-up status is surfaced instead of "idle", and a
		// follow-up pass is scheduled — the tail is never silently dropped.
		let iterations = 0;
		while (true) {
			if (handle.disposed) return;
			setStatus(workspaceRoot, handle, "syncing");
			try {
				setProgress(workspaceRoot, handle, {
					phase: "scan",
					done: 0,
					total: null,
				});
				// Plan-time safety net (item-1 race): hold anything that appeared
				// since the last pass BEFORE deciding, in the same tick.
				await markNewTopsUnvetted(workspaceRoot, handle);
				const computed = await planSync(backend, cloudFs, workspaceRoot);
				if (handle.disposed) return;
				setProgress(workspaceRoot, handle, {
					phase: computed.totalOps === 0 ? "done" : "push",
					done: 0,
					total: computed.totalOps,
				});
				await executeSyncPlan(
					computed,
					backend,
					cloudFs,
					workspaceRoot,
					(progress) => {
						if (!handle.disposed) setProgress(workspaceRoot, handle, progress);
					},
				);
				if (handle.disposed) return;
				// A comment pulled from another device sits on disk invisible
				// until the note reopens — tell the open document view now.
				await notifyPulledCommentLogs(workspaceRoot, handle, computed);
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
			if (handle.pending === 0) break;
			iterations += 1;
			if (iterations >= MAX_DRAIN_ITERATIONS) {
				// Cap boundary with a live tail: report catching-up (NOT idle)
				// and schedule the follow-up now. `handle.pending` is left
				// intact — zeroing it here is what used to drop the tail.
				setStatus(
					workspaceRoot,
					handle,
					"syncing",
					"More changes arrived while syncing — catching up…",
				);
				scheduleSync(workspaceRoot, handle, backend, cloudFs, 0);
				break;
			}
			handle.pending = 0;
		}
	} finally {
		handle.running = false;
	}
}

/**
 * Recovers the docId from a workspace-relative comment-log path by
 * stripping the `.mdly/comments/` prefix, a trailing ` <slot>` suffix, and
 * the `.jsonl` extension. Mirrors the server's slot pattern (and
 * `agentComments.ts`'s filename parsing) — null when not a comment log.
 */
function docIdFromCommentLogPath(sidecarPath: string): string | null {
	const prefix = ".mdly/comments/";
	if (!sidecarPath.startsWith(prefix)) return null;
	const match = /^(.+?)(?: (\d+))?\.jsonl$/i.exec(
		sidecarPath.slice(prefix.length),
	);
	return match ? match[1] : null;
}

/**
 * After a successful execute, maps freshly pulled/merged comment logs back
 * to their notes and fires `deps.notifyCommentsChanged` per note, so the
 * open document view refreshes live. Pushes need no notify (our own content
 * going up), history index shards are skipped (not comments), and a docId
 * with no current path (note without an id yet, or deleted) is skipped
 * silently. A half-written history index or a throwing listener must never
 * break the sync loop — every failure mode here degrades to "reopen to
 * see it", never to a broken sync.
 */
async function notifyPulledCommentLogs(
	workspaceRoot: string,
	handle: RunningCloudSync,
	computed: SyncPlan,
): Promise<void> {
	const notify = handle.deps?.notifyCommentsChanged;
	if (!notify) return;
	const commentPaths = [
		...(computed.sidecarOps?.toPull ?? []),
		...(computed.sidecarOps?.merged ?? []),
	]
		.map((op) => op.path)
		.filter((p) => p.startsWith(".mdly/comments/"));
	if (commentPaths.length === 0) return;
	let pathByDocId: Map<string, string>;
	try {
		const byPath = await resolvePathIndex(
			createDocHistoryNodeFileSystem(),
			historyRootFor(workspaceRoot),
		);
		pathByDocId = new Map<string, string>();
		for (const [relativePath, docId] of byPath) {
			pathByDocId.set(docId, relativePath);
		}
	} catch {
		return;
	}
	for (const sidecarPath of commentPaths) {
		const docId = docIdFromCommentLogPath(sidecarPath);
		if (!docId) continue;
		const relativePath = pathByDocId.get(docId);
		if (!relativePath) continue;
		try {
			notify(path.join(workspaceRoot, ...relativePath.split("/")));
		} catch {
			// A listener's own error must never break sync.
		}
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
	// Max-wait: a continuously-written tree still syncs at least every 5s
	// instead of debouncing forever.
	if (!handle.debounceTimer && !handle.maxWaitTimer) {
		handle.maxWaitTimer = setTimeout(() => {
			handle.maxWaitTimer = null;
			if (handle.debounceTimer) clearTimeout(handle.debounceTimer);
			handle.debounceTimer = null;
			void runOnce(workspaceRoot, handle, backend, cloudFs);
		}, MAX_DEBOUNCE_WAIT_MS);
	}
	if (handle.debounceTimer) clearTimeout(handle.debounceTimer);
	handle.debounceTimer = setTimeout(() => {
		handle.debounceTimer = null;
		if (handle.maxWaitTimer) {
			clearTimeout(handle.maxWaitTimer);
			handle.maxWaitTimer = null;
		}
		void runOnce(workspaceRoot, handle, backend, cloudFs);
	}, debounceMs);
}

/** Unvetted sets parked here across a watcher restart (stop deletes the handle that owned them). */
const carriedUnvetted = new Map<string, Set<string>>();

/**
 * Plan-time safety net for the live-arrival race: diffs the CURRENT top
 * level against `knownTops` immediately before planning, marking anything
 * new unvetted IN THE SAME TICK. The watcher path (`addDir`/file events)
 * is the fast lane, but chokidar delivery can lag seconds under load while
 * the sync max-wait fires on time — without this, a walk could see (and
 * push) a subtree no event has announced yet. One `readdir`, always cheap.
 */
async function markNewTopsUnvetted(
	workspaceRoot: string,
	handle: RunningCloudSync,
): Promise<void> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
	} catch {
		return;
	}
	const onDisk = new Set<string>();
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		onDisk.add(entry.name);
		if (handle.knownTops.has(entry.name)) continue;
		if (handle.unvettedDirs.has(entry.name)) continue;
		markDirUnvetted(
			workspaceRoot,
			handle,
			path.join(workspaceRoot, entry.name),
		);
		if (handle.deps) scheduleVetCheck(workspaceRoot, handle.deps, handle);
	}
	// Forget deleted tops so a later recreation reads as new again.
	for (const known of [...handle.knownTops]) {
		if (!onDisk.has(known)) handle.knownTops.delete(known);
	}
}
/**
 * Marks a newly-seen directory provisionally ineligible for sync. Only the
 * TOP-level segment matters: pending/excluded matching and the hold queue
 * are all top-level units. Nested dirs inside an already-tracked top are
 * just activity on that top.
 */
export function markDirUnvetted(
	workspaceRoot: string,
	handle: RunningCloudSync,
	absoluteDirPath: string,
): void {
	const rel = path
		.relative(workspaceRoot, absoluteDirPath)
		.split(path.sep)
		.join("/");
	if (rel === "" || rel.startsWith("..")) return;
	const top = rel.split("/")[0] as string;
	if (handle.unvettedDirs.has(top)) {
		handle.unvettedActivity.set(top, Date.now());
		return;
	}
	// Decided tops need no vetting: approved, excluded, pending, or the
	// workspace's own pre-existing dirs (vetted by the start-up detect).
	// Approval is durable — stale watcher backlog must never un-approve.
	if (handle.approvedFolders.includes(top)) return;
	// Already decided tops need no vetting: excluded, pending, or the
	// workspace's own pre-existing dirs are vetted by the start-up detect.
	// (A top that arrives while its parent is excluded never reaches here —
	// the watcher prunes it first.)
	handle.unvettedDirs.add(top);
	handle.unvettedActivity.set(top, Date.now());
	handle.topBursts.delete(top);
}

/** Schedules a vet check once — further events never reset it (resetting is what starved the old check under continuous arrival). */
function scheduleVetCheck(
	workspaceRoot: string,
	deps: CloudSyncWiringDeps,
	handle: RunningCloudSync,
): void {
	if (handle.disposed || handle.pendingCheckTimer) return;
	handle.pendingCheckTimer = setTimeout(() => {
		handle.pendingCheckTimer = null;
		void vetUnvettedDirs(workspaceRoot, deps).catch((error) => {
			console.error(`[cloud-sync] pending-folder check failed:`, error);
		});
	}, VET_DELAY_MS);
}

/**
 * Holds big arrivals fast, releases small ones carefully. Over-threshold →
 * held on ANY evaluation (even mid-churn: holding early is always safe).
 * Under-threshold → vetted only once QUIET *and* count-stable across two
 * consecutive checks (event-delivery lag can fake quiet; a stale read just
 * delays, never wrongly releases). Still-moving dirs stay unvetted and
 * re-schedule. The pause-resume backstop is the burst re-arm in
 * `onFileEvent`: a vetted-then-resumed dir trips it and is re-held with a
 * bounded leak.
 */
export async function vetUnvettedDirs(
	workspaceRoot: string,
	deps: CloudSyncWiringDeps,
): Promise<void> {
	const handle = activeSyncs.get(workspaceRoot);
	if (!handle || handle.disposed || handle.unvettedDirs.size === 0) return;

	const fsAdapter = createNodeFileSystem();
	const config = await readConfigOrDefault(fsAdapter, workspaceRoot);
	const cloudSync = config.cloudSync as CloudSyncConfig | undefined;
	if (!cloudSync) {
		handle.unvettedDirs.clear();
		handle.unvettedActivity.clear();
		handle.unvettedLastCount.clear();
		return;
	}
	const excluded = effectiveExcludedFolders(cloudSync);
	const pendingPaths = new Set(
		(cloudSync.pendingFolders ?? []).map((p) => p.path),
	);
	const approvedPaths = new Set(cloudSync.approvedFolders ?? []);

	const now = Date.now();
	const newlyHeld: PendingFolder[] = [];
	let vettedAny = false;
	let stillWaiting = false;

	function drop(top: string, opts?: { vetted?: boolean }): void {
		handle.unvettedDirs.delete(top);
		handle.unvettedActivity.delete(top);
		handle.unvettedLastCount.delete(top);
		handle.topBursts.delete(top);
		handle.knownTops.add(top);
		if (opts?.vetted) vettedAny = true;
	}

	for (const top of [...handle.unvettedDirs]) {
		// Decided elsewhere while we waited — just drop. Approved tops are
		// NEVER re-held: approval is durable, stale backlog must not un-approve.
		if (
			pendingPaths.has(top) ||
			approvedPaths.has(top) ||
			matchesExcludedPattern(top, excluded)
		) {
			drop(top);
			continue;
		}
		// Nested repos are never workspace content (D-LW1) — clear silently.
		// `.git` may be a directory (plain repo) or a file (worktree
		// gitlink); either marks a repo boundary.
		let isRepo = false;
		try {
			const gitlink = await fsAdapter.readFileOrNull(
				`${workspaceRoot}/${top}/.git`,
			);
			if (gitlink !== null) isRepo = true;
		} catch {
			// Unreadable — fall through to the directory probe.
		}
		if (!isRepo) {
			try {
				await fs.readdir(path.join(workspaceRoot, top, ".git"));
				isRepo = true;
			} catch {
				isRepo = false;
			}
		}
		if (isRepo) {
			drop(top);
			continue;
		}
		const count = countSubtreeWithEarlyBail(workspaceRoot, top);
		if (isOverPendingThreshold(count)) {
			newlyHeld.push({
				path: top,
				fileCountAtLeast: count.files,
				dirCountAtLeast: count.dirs,
				discoveredAt: Date.now(),
			});
			drop(top);
			continue;
		}
		// Small — release only when quiet AND stable since the last check.
		const lastActivity = handle.unvettedActivity.get(top) ?? 0;
		const prev = handle.unvettedLastCount.get(top);
		const quiet = now - lastActivity >= VET_QUIET_MS;
		const stable =
			prev !== undefined &&
			prev.files === count.files &&
			prev.dirs === count.dirs;
		if (quiet && stable) {
			drop(top, { vetted: true });
		} else {
			handle.unvettedLastCount.set(top, {
				files: count.files,
				dirs: count.dirs,
			});
			stillWaiting = true;
		}
	}

	if (newlyHeld.length > 0) {
		await writeCloudSyncConfig(fsAdapter, workspaceRoot, {
			...cloudSync,
			pendingFolders: [...(cloudSync.pendingFolders ?? []), ...newlyHeld],
		});
		// Restart so the hold takes effect at once, carrying still-unvetted
		// dirs across (a restart must never drop a provisional hold).
		await restartWatcherPreservingVetting(workspaceRoot, deps);
	} else if (vettedAny && handle.backend && handle.cloudFs) {
		// Newly-vetted files were filtered from every walk until now — run
		// one pass to pick them up.
		scheduleSync(workspaceRoot, handle, handle.backend, handle.cloudFs, 0);
	}

	if (stillWaiting) scheduleVetCheck(workspaceRoot, deps, handle);
}

/**
 * Tears a live watcher down and restarts it through the launch path,
 * carrying provisional holds across. Never a second parallel start.
 */
async function restartWatcherPreservingVetting(
	workspaceRoot: string,
	deps: CloudSyncWiringDeps,
): Promise<void> {
	const existing = activeSyncs.get(workspaceRoot);
	if (existing && existing.unvettedDirs.size > 0) {
		carriedUnvetted.set(workspaceRoot, new Set(existing.unvettedDirs));
	}
	if (isCloudSyncRunning(workspaceRoot)) {
		await stopCloudSyncForWorkspace(workspaceRoot);
		await startCloudSyncWatcherIfEnabled(workspaceRoot, deps);
	}
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
	if (!cloudSync || !cloudSync.backgroundSync) {
		const excludedFolders = effectiveExcludedFolders(cloudSync);
		return {
			backgroundSync: false,
			status: "off",
			workspaceId: cloudSync?.workspaceId ?? null,
			deploymentUrl: cloudSync?.deploymentUrl ?? null,
			detail: null,
			excludedFolders: [...excludedFolders],
			pendingFolders: cloudSync?.pendingFolders ?? [],
			progress: null,
		};
	}

	// First sync IS the pending queue at t=0: hold new over-threshold
	// folders BEFORE the watcher is built, so the first walk never descends
	// into them. Also runs on every resume/restart — continuous consent, not
	// one-time consent at enable.
	await detectAndHoldPendingFolders(workspaceRoot, deps);
	const fresh = await readConfigOrDefault(
		createNodeFileSystem(),
		workspaceRoot,
	);
	const freshSync = fresh.cloudSync as CloudSyncConfig | undefined;
	const excludedFolders = effectiveExcludedFolders(freshSync);
	const pendingFolders = freshSync?.pendingFolders ?? [];

	const token = await deps.keychain.getPassword(SHARED_CLOUD_SYNC_ACCOUNT);
	const handle: RunningCloudSync = {
		watcher: null as unknown as FSWatcher,
		subscriber: null as unknown as Subscriber,
		unsubscribeFiles: () => {},
		status: "connecting",
		detail: null,
		progress: null,
		workspaceId: cloudSync.workspaceId,
		deploymentUrl: cloudSync.deploymentUrl,
		excludedFolders,
		pendingFolders,
		approvedFolders: freshSync?.approvedFolders ?? [],
		debounceTimer: null,
		maxWaitTimer: null,
		pendingCheckTimer: null,
		unvettedDirs: new Set<string>(),
		unvettedActivity: new Map<string, number>(),
		unvettedLastCount: new Map<string, { files: number; dirs: number }>(),
		topBursts: new Map<string, number>(),
		knownTops: new Set<string>(),
		deps: null,
		running: false,
		pending: 0,
		disposed: false,
		backend: null,
		cloudFs: null,
	};
	// A restart (detect/approve/exclude/exclusion-edit) must not drop the
	// provisional hold on dirs that are still arriving — carry them over.
	const carried = carriedUnvetted.get(workspaceRoot);
	if (carried) {
		carriedUnvetted.delete(workspaceRoot);
		for (const dir of carried) {
			handle.unvettedDirs.add(dir);
			if (!handle.unvettedActivity.has(dir))
				handle.unvettedActivity.set(dir, Date.now());
		}
		if (carried.size > 0) scheduleVetCheck(workspaceRoot, deps, handle);
	}
	try {
		const tops = await fs.readdir(workspaceRoot, { withFileTypes: true });
		for (const entry of tops) handle.knownTops.add(entry.name);
	} catch {
		// Unreadable root — the first runOnce will surface it honestly.
	}
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
			pendingFolders,
			progress: null,
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
	handle.backend = backend;
	handle.deps = deps;
	const cloudFs = createCloudAwareFileSystem(
		createVettingFileSystem(
			createNodeFileSystem({
				// The sync walk must skip the SAME folders the watcher already skips
				// (`excludedFolders` above) — otherwise it walks (and re-walks, on
				// every debounced fs event) folders like `.claude` that a workspace's
				// own git worktrees can churn thousands of entries deep, which is both
				// slow and a source of "file deleted mid-walk" races. Pending
				// folders are appended here too: "pending" scopes to THAT folder,
				// never the whole workspace — the rest keeps syncing.
				excludedFolders: [
					...excludedFolders,
					...pendingFolders.map((p) => p.path),
				],
				maxEntries: SYNC_MAX_ENTRIES,
				maxDirectories: SYNC_MAX_DIRECTORIES,
				// Honest indeterminate progress: a throttled count-up ("scanned N
				// entries…") while the walk runs — no total exists until plan()
				// returns, so there is deliberately no bar here.
				onScan: (() => {
					let lastEmit = 0;
					return (visited: {
						visitedEntryCount: number;
						visitedDirectoryCount: number;
					}) => {
						const now = Date.now();
						if (now - lastEmit < 100) return;
						lastEmit = now;
						if (!handle.disposed)
							setProgress(workspaceRoot, handle, {
								phase: "scan",
								done: visited.visitedEntryCount,
								total: null,
							});
					};
				})(),
			}),
			// Provisionally-unvetted subtrees are filtered here (item-1 race
			// fix): a sync firing mid-arrival walks but pushes nothing from
			// the new subtree, no matter how the timers interleave.
			handle.unvettedDirs,
		),
		deps,
	);
	handle.cloudFs = cloudFs;

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

	const watcher = createWatcher(workspaceRoot, [
		...excludedFolders,
		...pendingFolders.map((p) => p.path),
	]);
	handle.watcher = watcher;
	const onFsEvent = () =>
		scheduleSync(workspaceRoot, handle, backend, cloudFs, debounceMs);
	// A new worktree arrives as thousands of individual watcher events, not
	// one "folder added". Each new top-level dir becomes provisionally
	// INELIGIBLE for sync immediately (the vetting decorator filters it),
	// and a coalesced vet check — scheduled once, never reset by further
	// events — holds or clears it once its arrival goes quiet. The old shape
	// raced two independent timers (sync max-wait vs. a resettable 2s check)
	// and could sync a worktree before the hold applied.
	const onDirEvent = (dirPath?: string) => {
		onFsEvent();
		if (handle.disposed) return;
		if (typeof dirPath === "string")
			markDirUnvetted(workspaceRoot, handle, dirPath);
		scheduleVetCheck(workspaceRoot, deps, handle);
	};
	// File events inside a provisionally-unvetted top refresh its activity:
	// a flat drip of files (no new subdirs) is still an arrival in progress,
	// not quiet. A file event under a top that is neither known nor unvetted
	// means addDir was missed or is in flight — mark it unvetted here. And a
	// BURST of events on an already-vetted top re-arms the hold: that is a
	// resumed arrival (pause-resume), not ordinary editing.
	const onFileEvent = (filePath?: string) => {
		onFsEvent();
		if (handle.disposed || typeof filePath !== "string") return;
		const rel = path
			.relative(workspaceRoot, filePath)
			.split(path.sep)
			.join("/");
		if (!rel.includes("/")) return;
		const top = rel.split("/")[0] as string;
		if (handle.unvettedDirs.has(top)) {
			handle.unvettedActivity.set(top, Date.now());
		} else if (!handle.knownTops.has(top)) {
			markDirUnvetted(workspaceRoot, handle, path.join(workspaceRoot, top));
			scheduleVetCheck(workspaceRoot, deps, handle);
		} else {
			// Approved tops never re-arm: approval is durable, and the
			// post-approval event backlog of a big arrival is exactly the
			// burst shape — counting it would un-approve within seconds.
			if (handle.approvedFolders.includes(top)) return;
			const burst = (handle.topBursts.get(top) ?? 0) + 1;
			handle.topBursts.set(top, burst);
			if (burst >= VET_BURST_REARM) {
				handle.topBursts.delete(top);
				handle.knownTops.delete(top);
				markDirUnvetted(workspaceRoot, handle, path.join(workspaceRoot, top));
				scheduleVetCheck(workspaceRoot, deps, handle);
			}
		}
	};
	watcher.on("add", onFileEvent);
	watcher.on("change", onFileEvent);
	watcher.on("unlink", onFileEvent);
	watcher.on("addDir", onDirEvent);
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
		pendingFolders: [...handle.pendingFolders],
		progress: handle.progress,
	};
}

/** Closes the watcher/subscriber/timer without removing the handle from `activeSyncs` — used only for the `workspace-unavailable` case (R24) so `getCloudSyncStatus`/`onCloudSyncStatusChange` keep reporting the error instead of silently resetting to "off". Idempotent. */
async function teardownRuntimeKeepingStatus(
	handle: RunningCloudSync,
): Promise<void> {
	if (handle.disposed) return;
	handle.disposed = true;
	if (handle.debounceTimer) clearTimeout(handle.debounceTimer);
	if (handle.maxWaitTimer) clearTimeout(handle.maxWaitTimer);
	if (handle.pendingCheckTimer) clearTimeout(handle.pendingCheckTimer);
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
	/** Folders the first-sync review dialog left unchecked — persisted as the initial `excludedFolders` instead of the defaults. */
	excludedFolders?: readonly string[];
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
		// The review dialog's unchecked folders win; otherwise carry over
		// rather than rebuild (re-enabling must not silently drop the list).
		// Left undefined when unset, so the key stays absent and defaults apply.
		excludedFolders: options.excludedFolders
			? [...options.excludedFolders]
			: existing.cloudSync?.excludedFolders
				? [...existing.cloudSync.excludedFolders]
				: undefined,
		pendingFolders: existing.cloudSync?.pendingFolders
			? [...existing.cloudSync.pendingFolders]
			: undefined,
		approvedFolders: existing.cloudSync?.approvedFolders
			? [...existing.cloudSync.approvedFolders]
			: undefined,
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
 * trimmed, blanks dropped, duplicates removed, original order kept. Both
 * bare names (`node_modules`, matched at any depth) and workspace-anchored
 * paths (`fe/docs`) are allowed — a selection UI inherently produces paths.
 */
export function normalizeExcludedFolders(folders: readonly string[]): string[] {
	return normalizeExcludedEntries(folders);
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

	await restartWatcherPreservingVetting(workspaceRoot, deps);
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
		pendingFolders: [...(cloudSync?.pendingFolders ?? [])],
		progress: running?.progress ?? null,
	};
}

export interface PrepareCloudSyncPreviewOptions {
	workspaceRoot: string;
	workspaceName: string;
	deploymentUrl: string;
	/** The shared password — stored in the Keychain when supplied (same as enable). Omit to reuse whatever is stored. */
	password?: string;
}

/**
 * First-sync review preview (D-LW4) that can run BEFORE enabling: stores the
 * password, ensures the remote workspace record exists, and persists a
 * PREPARED config (`backgroundSync: false` — nothing starts) so the SAME
 * `plan()` the real sync will execute produces the counts. Will-sync rows
 * come straight from the plan; pruned tops come back as greyed rows with
 * their REAL reason (`classifyExcludedTop` — never guessed in the UI).
 * Scan progress streams over the progress channel (the dialog subscribes
 * before invoking), because `ipcMain.handle` is request/response.
 */
export async function prepareCloudSyncPreview(
	options: PrepareCloudSyncPreviewOptions,
	deps: CloudSyncWiringDeps,
): Promise<{ plan: SyncPlan; folders: FolderSummaryEntry[] }> {
	if (options.password) {
		await deps.keychain.setPassword(
			SHARED_CLOUD_SYNC_ACCOUNT,
			options.password,
		);
	}
	const token = await deps.keychain.getPassword(SHARED_CLOUD_SYNC_ACCOUNT);
	if (!token) {
		throw new Error(
			"Enter the Cloud Sync password once to preview what will sync.",
		);
	}

	const createBackend = deps.createBackend ?? defaultCreateBackend;
	const backend = createBackend({
		deploymentUrl: options.deploymentUrl,
		token,
	});
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
		backgroundSync: false,
		excludedFolders: existing.cloudSync?.excludedFolders,
		pendingFolders: existing.cloudSync?.pendingFolders,
		approvedFolders: existing.cloudSync?.approvedFolders,
	});
	const prepared = await readConfigOrDefault(fsAdapter, options.workspaceRoot);
	const preparedSync = prepared.cloudSync as CloudSyncConfig | undefined;
	const excluded = effectiveExcludedFolders(preparedSync);
	const pendingPaths = (preparedSync?.pendingFolders ?? []).map((p) => p.path);

	const previewFs = createCloudAwareFileSystem(
		createNodeFileSystem({
			excludedFolders: [...excluded, ...pendingPaths],
			maxEntries: SYNC_MAX_ENTRIES,
			maxDirectories: SYNC_MAX_DIRECTORIES,
			onScan: (() => {
				let lastEmit = 0;
				return (visited: {
					visitedEntryCount: number;
					visitedDirectoryCount: number;
				}) => {
					const now = Date.now();
					if (now - lastEmit < 100) return;
					lastEmit = now;
					notifyProgress(options.workspaceRoot, {
						phase: "scan",
						done: visited.visitedEntryCount,
						total: null,
					});
				};
			})(),
		}),
		deps,
	);
	const computed = await planSync(backend, previewFs, options.workspaceRoot);

	// Greyed rows: pruned tops the plan never sees. Reasons come from the
	// engine (`classifyExcludedTop`), one walker, bounded counts.
	const excludedRows: FolderSummaryEntry[] = [];
	let tops: import("node:fs").Dirent[];
	try {
		tops = await fs.readdir(options.workspaceRoot, { withFileTypes: true });
	} catch {
		tops = [];
	}
	const pendingSet = new Set(pendingPaths);
	for (const entry of tops) {
		if (!entry.isDirectory()) continue;
		const rel = entry.name;
		const pruned = pendingSet.has(rel) || matchesExcludedPattern(rel, excluded);
		if (!pruned) continue;
		const info = await classifyExcludedTop(options.workspaceRoot, rel);
		excludedRows.push({
			folder: rel,
			fileCount: info.fileCountAtLeast,
			bytes: info.bytes,
			autoExcluded: info.reason,
		});
	}
	excludedRows.sort((a, b) => b.fileCount - a.fileCount);

	notifyProgress(options.workspaceRoot, {
		phase: "done",
		done: computed.totalOps,
		total: computed.totalOps,
	});
	return { plan: computed, folders: [...computed.folders, ...excludedRows] };
}

/**
 * Scans the workspace's top-level folders for new large ones (D-LW5):
 * `>1000 files OR >1000 directories` (early bail at 1,001 — the exact
 * number is never needed). Over-threshold folders NOT already excluded or
 * pending are appended to `pendingFolders` and held out of sync; the rest
 * of the workspace keeps syncing. Returns the newly held folders.
 */
export async function detectAndHoldPendingFolders(
	workspaceRoot: string,
	deps: CloudSyncWiringDeps,
): Promise<PendingFolder[]> {
	const fsAdapter = createNodeFileSystem();
	const config = await readConfigOrDefault(fsAdapter, workspaceRoot);
	const cloudSync = config.cloudSync as CloudSyncConfig | undefined;
	if (!cloudSync) return [];
	const excluded = effectiveExcludedFolders(cloudSync);
	const existingPending = new Map(
		(cloudSync.pendingFolders ?? []).map((p) => [p.path, p]),
	);
	const excludedSet = new Set(excluded);
	const approvedSet = new Set(cloudSync.approvedFolders ?? []);
	let topEntries: import("node:fs").Dirent[];
	try {
		topEntries = await fs.readdir(workspaceRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const newly: PendingFolder[] = [];
	for (const entry of topEntries) {
		if (!entry.isDirectory()) continue;
		const rel = entry.name;
		if (existingPending.has(rel) || excludedSet.has(rel)) continue;
		// Approved once, approved for good — the start-up detect never re-holds.
		if (approvedSet.has(rel)) continue;
		if (matchesExcludedPattern(rel, [...excluded])) continue;
		// Nested repos (a dir with its own `.git`) are auto-excluded silently
		// per D-LW1 — they never reach the pending queue.
		let isRepo = false;
		try {
			await fs.access(path.join(workspaceRoot, rel, ".git"));
			isRepo = true;
		} catch {
			isRepo = false;
		}
		if (isRepo) continue;
		const count = countSubtreeWithEarlyBail(workspaceRoot, rel);
		if (!isOverPendingThreshold(count)) continue;
		newly.push({
			path: rel,
			fileCountAtLeast: count.files,
			dirCountAtLeast: count.dirs,
			discoveredAt: Date.now(),
		});
	}
	if (newly.length === 0) return [];
	await writeCloudSyncConfig(fsAdapter, workspaceRoot, {
		...cloudSync,
		pendingFolders: [...(cloudSync.pendingFolders ?? []), ...newly],
	});
	// A live watcher was built without these folders in its exclusion set —
	// restart through the same path launch uses so the hold takes effect at
	// once (never a second, parallel start). The rest of the workspace keeps
	// syncing; "pending" scopes to the held folders only.
	await restartWatcherPreservingVetting(workspaceRoot, deps);
	if (!isCloudSyncRunning(workspaceRoot)) {
		const handle = activeSyncs.get(workspaceRoot);
		if (handle) handle.pendingFolders.push(...newly);
		notifyStatus(
			workspaceRoot,
			handle?.status ?? "idle",
			handle?.detail ?? null,
			handle?.progress ?? null,
		);
	}
	return newly;
}

/** Approves a pending folder: it syncs from now on. Restarts a live watcher so the newly-included subtree is actually watched. */
export async function approvePendingFolder(
	workspaceRoot: string,
	folderPath: string,
	deps: CloudSyncWiringDeps,
): Promise<CloudSyncWorkspaceState> {
	const fsAdapter = createNodeFileSystem();
	const config = await readConfigOrDefault(fsAdapter, workspaceRoot);
	const cloudSync = config.cloudSync as CloudSyncConfig | undefined;
	if (!cloudSync)
		throw new Error("Turn Cloud Sync on for this workspace first.");
	await writeCloudSyncConfig(fsAdapter, workspaceRoot, {
		...cloudSync,
		pendingFolders: (cloudSync.pendingFolders ?? []).filter(
			(p) => p.path !== folderPath,
		),
		// Durable: the vet check (and the start-up detect) never re-hold an
		// approved path, so stale watcher backlog cannot un-approve it.
		approvedFolders: [
			...(cloudSync.approvedFolders ?? []).filter((p) => p !== folderPath),
			folderPath,
		],
	});
	// Approval is a decision — clear any provisional hold so the vet check
	// cannot re-hold the same (still big) folder after the restart.
	activeSyncs.get(workspaceRoot)?.unvettedDirs.delete(folderPath);
	activeSyncs.get(workspaceRoot)?.unvettedActivity.delete(folderPath);
	activeSyncs.get(workspaceRoot)?.unvettedLastCount.delete(folderPath);
	activeSyncs.get(workspaceRoot)?.topBursts.delete(folderPath);
	await restartWatcherPreservingVetting(workspaceRoot, deps);
	return readCloudSyncWorkspaceState(workspaceRoot);
}

/** Excludes a pending folder forever ("never ask again"): moved to `excludedFolders`, removed from the queue. A recreated worktree never re-nags. */
export async function excludePendingFolder(
	workspaceRoot: string,
	folderPath: string,
	deps: CloudSyncWiringDeps,
): Promise<CloudSyncWorkspaceState> {
	const fsAdapter = createNodeFileSystem();
	const config = await readConfigOrDefault(fsAdapter, workspaceRoot);
	const cloudSync = config.cloudSync as CloudSyncConfig | undefined;
	if (!cloudSync)
		throw new Error("Turn Cloud Sync on for this workspace first.");
	const excluded = [...effectiveExcludedFolders(cloudSync)];
	if (!excluded.includes(folderPath)) excluded.push(folderPath);
	await writeCloudSyncConfig(fsAdapter, workspaceRoot, {
		...cloudSync,
		excludedFolders: excluded,
		pendingFolders: (cloudSync.pendingFolders ?? []).filter(
			(p) => p.path !== folderPath,
		),
		// A path cannot be both approved and excluded — exclusion wins.
		approvedFolders: (cloudSync.approvedFolders ?? []).filter(
			(p) => p !== folderPath,
		),
	});
	await restartWatcherPreservingVetting(workspaceRoot, deps);
	return readCloudSyncWorkspaceState(workspaceRoot);
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
