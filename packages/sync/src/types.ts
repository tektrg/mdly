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
				// Folder NAMES (never paths) that the desktop background watcher
				// must never descend into, matched at any depth below the
				// workspace root. Absent means "use the built-in defaults" rather
				// than "exclude nothing", so configs written before this field
				// existed keep working and the default list can grow later
				// without rewriting every workspace's config file.
				excludedFolders: z.array(z.string()).optional(),
			})
			.optional(),
	})
	.passthrough();
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type CloudSyncConfig = NonNullable<WorkspaceConfig["cloudSync"]>;

export const FileStateSchema = z.object({
	hash: z.string(),
	lastSyncedAt: z.number(),
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
