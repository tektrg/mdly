import { z } from "zod/v4";

// Stage 4 finding: `.hubble/config.json` is shared with the desktop app's own
// `pinnedNotes`/`version` fields (apps/desktop/electron/main.ts's
// `workspaceConfigSchema`), which this schema previously didn't know about.
// `z.object()` strips unrecognized keys on `.parse()` by default, so reading
// a desktop-authored config through `readConfigOrDefault`/`readConfig` and
// writing it back through `writeCloudSyncConfig` (both round-trip through
// this schema) would silently drop `pinnedNotes`/`version` from the file the
// next time any `hubble cloud` command ran. `.passthrough()` keeps any
// unrecognized top-level key intact across that round trip; it does not
// change validation of the fields this schema DOES know about.
export const PendingFolderSchema = z.object({
	/** Workspace-relative POSIX path of the held folder. */
	path: z.string(),
	/** Lower bound — the detector bails at 1,001, so this is "at least". */
	fileCountAtLeast: z.number(),
	dirCountAtLeast: z.number().optional(),
	discoveredAt: z.number(),
});
export type PendingFolder = z.infer<typeof PendingFolderSchema>;

export const WorkspaceConfigSchema = z
	.object({
		cloudSync: z
			.object({
				provider: z.literal("cloudflare"),
				deploymentUrl: z.string(),
				workspaceId: z.string(),
				deviceId: z.string(),
				backgroundSync: z.boolean(),
				// Stage 5b (R36 honesty requirement): set when turning cloud sync
				// off tried and FAILED to delete this workspace's cloud copy
				// (offline, rotated password, etc.) -- the local toggle still goes
				// off immediately, but this flag records that the cloud copy has
				// NOT actually been removed yet, so a later launch can retry rather
				// than the Mac silently claiming "deleted" when nothing was.
				// Cleared once the retry succeeds.
				pendingRemoteDelete: z.boolean().optional(),
				// Exclusion entries with gitignore's own convention in ONE list: a
				// bare name (`node_modules`) matches at any depth; an entry
				// containing a separator (`fe/docs`) is anchored to the workspace
				// root. Built-in defaults stay name-based and unchanged. Absent
				// means "use the built-in defaults" rather than "exclude
				// nothing".
				excludedFolders: z.array(z.string()).optional(),
				// Folders held out of sync until the user approves them (D-LW5).
				// First sync IS this queue at t=0 — one surface, one persisted
				// state, not two features.
				pendingFolders: z.array(PendingFolderSchema).optional(),
				// Top-level dirs the user explicitly approved. Approval is
				// DURABLE: the vet check never spontaneously re-holds an
				// approved path (stale watcher backlog must not un-approve),
				// and restarts/enables carry it over like exclusions.
				approvedFolders: z.array(z.string()).optional(),
			})
			.optional(),
	})
	.passthrough();
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type CloudSyncConfig = NonNullable<WorkspaceConfig["cloudSync"]>;

export const FileStateSchema = z.object({
	hash: z.string(),
	lastSyncedAt: z.number(),
	// Cheap-change-detection hint (D-LW Tier 1.2): "might have changed →
	// verify by hashing", never proof. Optional so state files written before
	// these fields existed still parse. Unit is SECONDS since epoch (the
	// walker's clock) — states written by the previous cut used ms and will
	// simply miss the hint once, then rewrite. A miss only costs a hash.
	mtime: z.number().optional(),
	size: z.number().optional(),
});
export type FileState = z.infer<typeof FileStateSchema>;

export const SyncStateSchema = z.object({
	lastSyncedAt: z.number(),
	files: z.record(z.string(), FileStateSchema),
	assets: z.record(z.string(), FileStateSchema).optional(),
});
export type SyncState = z.infer<typeof SyncStateSchema>;

export type SyncResult = {
	pushed: string[];
	pulled: string[];
	deleted: string[];
	conflicts: string[];
	unchanged: number;
	assetsPushed: number;
	assetsPulled: number;
	assetsDeleted: number;
};

export type RemoteFile = {
	_id: string;
	path: string;
	contentHash: string;
	content: string;
	updatedAt: number;
	deviceId: string;
	deleted: boolean;
};

export type RemoteAsset = {
	_id: string;
	path: string;
	storageId: string;
	contentHash: string;
	updatedAt: number;
	deviceId: string;
	deleted: boolean;
};

/**
 * A same-origin-or-authenticated URL for a raw asset upload/download.
 * `headers` carries whatever the caller must attach to actually reach it —
 * a bearer `Authorization` header for a non-browser (CLI/desktop) caller, or
 * nothing at all for a browser caller, since a same-origin `fetch`/`<img>`
 * request already carries the session cookie automatically. This is the fix
 * for the "bare unauthenticated fetch" defect: every backend now hands back
 * whatever is needed to actually reach the URL, instead of the sync engine
 * (or apps/www) guessing at auth on its own.
 */
export type AuthorizedUrl = {
	url: string;
	headers?: Record<string, string>;
};

/** Auto-exclusion reason shown greyed with the folder in the review UI. */
export type FolderAutoExcludeReason =
	| "gitignored"
	| "nested-repo"
	| "over-threshold";

/** Per-folder roll-up of a sync plan — the review UI selects folders, not files. */
export type FolderSummaryEntry = {
	/** Top-level folder (POSIX, relative), or "(root)" for workspace-top files. */
	folder: string;
	fileCount: number;
	bytes: number;
	autoExcluded?: FolderAutoExcludeReason;
};

/** One decided file action inside a plan. */
export type PlannedPush = {
	path: string;
	hash: string;
	content: string;
	mtime?: number;
	size?: number;
};
export type PlannedPull = { path: string; hash: string; content: string };
export type PlannedDelete = {
	path: string;
	kind: "local" | "remote-tombstone";
};

/**
 * The decidable half of sync (D-LW3): everything `execute()` will do,
 * computed before anything is pushed/pulled. The dry-run preview and the
 * real count come from the SAME call, so the number shown before enabling
 * is the number that actually happens.
 */
export type SyncPlan = {
	toPush: PlannedPush[];
	toPull: PlannedPull[];
	toDelete: PlannedDelete[];
	conflicts: string[];
	unchanged: number;
	assetOps: {
		toPush: { path: string; hash: string; mtime?: number; size?: number }[];
		toPull: string[];
		toDelete: string[];
	};
	folders: FolderSummaryEntry[];
	totalOps: number;
};

/** Structured progress payload — the old enum+string channel cannot carry counts. */
export type SyncProgress = {
	/** `scan` is indeterminate (no total exists until the walk ends). */
	phase: "scan" | "push" | "pull" | "assets" | "done";
	done: number;
	total: number | null;
	currentPath?: string;
};

export type SyncProgressCallback = (progress: SyncProgress) => void;
