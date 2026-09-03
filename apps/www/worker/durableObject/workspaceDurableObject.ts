import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";
import { workspaceStorageCapBytes } from "../env.js";
import {
	clearAssetOrphaned,
	getAssets,
	listAllAssetsForGc,
	markAssetDeletedByGc,
	markAssetOrphaned,
	referencedHashesInWorkspace,
	softDeleteAsset,
	upsertAsset,
} from "./assets.js";
import { acceptHibernatingWebSocket, broadcastVersion } from "./broadcast.js";
import { type DeviceRow, registerDevice } from "./devices.js";
import {
	BatchByteLimitError,
	BatchEmptyError,
	BatchTooLargeError,
	FileTooLargeError,
	StorageCapExceededError,
	toRpcError,
	type WorkerErrorCode,
} from "./errors.js";
import {
	assertCommentLogSlotInvariant,
	getFiles,
	type RemoteFileLike,
	softDeleteFile,
	upsertFile,
} from "./files.js";
import {
	approximateWorkspaceBytes,
	bumpVersion,
	currentVersion,
	ensureSchema,
} from "./schema.js";
import { canonicalFilePath } from "../paths.js";

export type { RemoteAssetLike } from "./assets.js";
export type { RemoteFileLike } from "./files.js";

export type PushResult =
	| { ok: true; version: number }
	| { ok: false; code: WorkerErrorCode | "UNKNOWN"; message: string };

/** Maximum files per `pushFilesBatch` call — see that method's docstring. */
export const MAX_PUSH_BATCH_FILES = 100;

/**
 * Maximum total content bytes per `pushFilesBatch` call — well under the ~32MiB
 * Workers RPC argument limit, so an oversized batch fails as a clean 413 in
 * the route (before the RPC call) instead of a 500 leaking RPC internals.
 */
export const MAX_PUSH_BATCH_BYTES = 8 * 1024 * 1024;

/**
 * Maximum content bytes per single `pushFile` call. Same ~32MiB RPC ceiling
 * as the batch limit: a bigger payload would die inside the RPC layer with a
 * 500 leaking internals, so the single-push route rejects it pre-RPC with a
 * clean 413 and the DO re-checks here as defence in depth.
 */
export const MAX_PUSH_FILE_BYTES = 8 * 1024 * 1024;

/**
 * One Durable Object instance per workspace (`WORKSPACE_DO.idFromName(name)`),
 * SQLite storage. All ten `SyncBackend` methods that are workspace-scoped
 * live here as RPC methods (Workers RPC — callable directly on the stub, no
 * hand-rolled fetch/Request marshalling for the common case); the WebSocket
 * upgrade is the one path that must go through `fetch()` since only fetch
 * can return a 101 Switching Protocols response.
 */
export class WorkspaceDurableObject extends DurableObject<Env> {
	private readonly sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		ensureSchema(this.sql);
	}

	// --- WebSocket upgrade (hibernating) ---

	async fetch(request: Request): Promise<Response> {
		const upgrade = request.headers.get("Upgrade");
		if (upgrade?.toLowerCase() !== "websocket") {
			return new Response("Expected WebSocket upgrade", { status: 426 });
		}
		const pair = new WebSocketPair();
		return acceptHibernatingWebSocket(this.ctx, pair);
	}

	async webSocketMessage(
		ws: WebSocket,
		_message: string | ArrayBuffer,
	): Promise<void> {
		// Clients don't send anything meaningful today beyond keepalive pings;
		// echo the current version so a client can use this as a manual
		// resync nudge without waiting for the next mutation.
		try {
			ws.send(JSON.stringify({ type: "version", version: this.getVersion() }));
		} catch {
			// socket already gone
		}
	}

	async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean,
	): Promise<void> {
		try {
			ws.close(code, reason);
		} catch {
			// already closed
		}
	}

	async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
		// The hibernation runtime removes errored sockets from
		// getWebSockets() on its own; nothing additional to clean up.
	}

	// --- Meta ---

	getVersion(): number {
		return currentVersion(this.sql);
	}

	// --- Files (SyncBackend) ---

	listFiles(opts?: {
		since?: number;
		includeDeleted?: boolean;
	}): RemoteFileLike[] {
		return getFiles(this.sql, opts);
	}

	pushFile(args: {
		path: string;
		contentHash: string;
		content: string;
		deviceId: string;
	}): PushResult {
		let path: string;
		try {
			path = canonicalFilePath(args.path);
			assertCommentLogSlotInvariant(this.sql, path, args.deviceId);
			if (args.content.length > MAX_PUSH_FILE_BYTES) {
				throw new FileTooLargeError(
					args.content.length,
					MAX_PUSH_FILE_BYTES,
				);
			}
			// Delta, not raw length: re-saving an unchanged file costs ~zero,
			// so a workspace near its cap can still save what it already has.
			this.assertWithinStorageCap(
				args.content.length - this.liveBytesForPath(path),
			);
		} catch (error) {
			return toRpcError(error);
		}

		upsertFile(this.sql, { ...args, path });
		const version = bumpVersion(this.sql);
		broadcastVersion(this.ctx, version);
		return { ok: true, version };
	}

	deleteFile(args: { path: string; deviceId: string }): PushResult {
		try {
			const raw = args.path;
			const path = canonicalFilePath(raw);
			assertCommentLogSlotInvariant(this.sql, path, args.deviceId);
			// Legacy rows stored pre-normalisation live under the raw
			// spelling: prefer a live exact match on the raw path as sent,
			// else the canonical row. Live-only, so a soft-deleted canonical
			// row can't shadow a live legacy one — and with both live, the
			// exact match wins instead of stranding the legacy row.
			const storedPath =
				raw !== path && this.liveFileRowExists(raw) ? raw : path;
			softDeleteFile(this.sql, { path: storedPath, deviceId: args.deviceId });
		} catch (error) {
			return toRpcError(error);
		}
		const version = bumpVersion(this.sql);
		broadcastVersion(this.ctx, version);
		return { ok: true, version };
	}

	/** True when a LIVE file row exists under exactly this path. */
	private liveFileRowExists(path: string): boolean {
		return (
			this.sql
				.exec<{ one: number }>(
					`SELECT 1 AS one FROM files WHERE path = ? AND deleted = 0`,
					path,
				)
				.toArray().length > 0
		);
	}

	/** True when a LIVE asset row exists under exactly this path. */
	private liveAssetRowExists(path: string): boolean {
		return (
			this.sql
				.exec<{ one: number }>(
					`SELECT 1 AS one FROM assets WHERE path = ? AND deleted = 0`,
					path,
				)
				.toArray().length > 0
		);
	}

	/**
	 * Pushes many files in one call with a single cap check and a single
	 * version bump/broadcast (BUG-LW1 Task 2) — the server half of fixing the
	 * client's one-HTTP-request-per-file first sync. The existing single-file
	 * `pushFile` is unchanged; the client-side switch to batching is a
	 * separate change.
	 *
	 * Limits (documented contract):
	 * - At most MAX_PUSH_BATCH_FILES files per call; more is rejected with
	 *   BATCH_TOO_LARGE (400) before anything is written — a single DO call
	 *   must stay well under CPU/time limits, so batches stay small and the
	 *   client splits large syncs into sequential batches.
	 * - At most MAX_PUSH_BATCH_BYTES total content bytes per call; more is
	 *   rejected with BATCH_BYTE_LIMIT (413) — well under the ~32MiB RPC
	 *   argument ceiling. The Worker route enforces both limits before the
	 *   RPC call; these DO-side checks are defence in depth.
	 * - One cap check for the whole batch, computed as the net delta (sum of
	 *   `new length − old live length`, like `upsertFile` does) — pure
	 *   overwrites cost ~zero, so a bulk re-sync of unchanged files is never
	 *   spuriously 413'd. New lengths are JS `.length` (a conservative
	 *   over-estimate vs SQLite `LENGTH()` for non-BMP text: may reject
	 *   slightly early near the cap, never late).
	 *
	 * Invariants preserved per file: every path is canonicalised first (so
	 * `./` and whitespace variants hit the same slot check as the plain
	 * path, and `../` escapes are rejected with INVALID_PATH), then
	 * `assertCommentLogSlotInvariant` still runs for every file — a violation
	 * rejects the whole batch with nothing written.
	 *
	 * Atomic: the write loop + `bumpVersion` run inside
	 * `transactionSync`, so a mid-loop throw (e.g. storage full) rolls the
	 * whole batch back — including the byte-counter adjustments, which are
	 * ordinary row writes in the same transaction. The broadcast fires only
	 * after the transaction commits, so clients never miss committed files
	 * behind an unchanged version.
	 */
	pushFilesBatch(args: {
		files: {
			path: string;
			contentHash: string;
			content: string;
			deviceId: string;
		}[];
	}): PushResult {
		let canonical: {
			path: string;
			contentHash: string;
			content: string;
			deviceId: string;
		}[];
		try {
			if (args.files.length > MAX_PUSH_BATCH_FILES) {
				throw new BatchTooLargeError(
					args.files.length,
					MAX_PUSH_BATCH_FILES,
				);
			}
			if (args.files.length === 0) {
				throw new BatchEmptyError();
			}
			canonical = args.files.map((file) => ({
				...file,
				path: canonicalFilePath(file.path),
			}));
			const batchBytes = canonical.reduce(
				(sum, file) => sum + file.content.length,
				0,
			);
			if (batchBytes > MAX_PUSH_BATCH_BYTES) {
				throw new BatchByteLimitError(batchBytes, MAX_PUSH_BATCH_BYTES);
			}
			for (const file of canonical) {
				assertCommentLogSlotInvariant(this.sql, file.path, file.deviceId);
			}
			this.assertWithinStorageCap(this.incomingBatchDeltaBytes(canonical));
		} catch (error) {
			return toRpcError(error);
		}

		try {
			const version = this.ctx.storage.transactionSync(() => {
				for (const file of canonical) {
					upsertFile(this.sql, file);
				}
				return bumpVersion(this.sql);
			});
			broadcastVersion(this.ctx, version);
			return { ok: true, version };
		} catch (error) {
			return toRpcError(error);
		}
	}

	/**
	 * Live bytes currently stored under a canonical path: SQLite `LENGTH()`
	 * of the content when the row exists and is not deleted, else zero.
	 * Matches the byte counter's semantics exactly. One PK read — O(1).
	 */
	private liveBytesForPath(path: string): number {
		const old = this.sql
			.exec<{ len: number; deleted: number }>(
				`SELECT LENGTH(content) AS len, deleted FROM files WHERE path = ?`,
				path,
			)
			.toArray()[0];
		return old && old.deleted === 0 ? old.len : 0;
	}

	/**
	 * Net bytes a batch would add: sum of `new length − old live length` per
	 * file (deleted/missing old rows contribute zero). One PK read per file —
	 * O(files), never a scan. Old lengths use SQLite `LENGTH()` semantics to
	 * match the byte counter exactly.
	 */
	private incomingBatchDeltaBytes(
		files: { path: string; content: string }[],
	): number {
		let delta = 0;
		for (const file of files) {
			const newLen =
				typeof file.content === "string" ? file.content.length : 0;
			delta += newLen - this.liveBytesForPath(file.path);
		}
		return delta;
	}

	// --- Assets (SyncBackend) ---

	listAssets(since?: number) {
		return getAssets(this.sql, since);
	}

	/**
	 * Records an asset row for `hash`. The caller (the Worker's asset-upload
	 * route) must have already confirmed the R2 object exists — see
	 * worker/routes/assets.ts — which is what makes R6's "never a dangling
	 * reference" guarantee hold without this DO needing an R2 binding of its
	 * own.
	 */
	pushAsset(args: {
		path: string;
		hash: string;
		deviceId: string;
	}): PushResult {
		let path: string;
		try {
			path = canonicalFilePath(args.path);
		} catch (error) {
			return toRpcError(error);
		}
		upsertAsset(this.sql, { ...args, path });
		const version = bumpVersion(this.sql);
		broadcastVersion(this.ctx, version);
		return { ok: true, version };
	}

	deleteAsset(args: { path: string; deviceId: string }): PushResult {
		try {
			const raw = args.path;
			const path = canonicalFilePath(raw);
			assertCommentLogSlotInvariant(this.sql, path, args.deviceId);
			// Asset rows were never normalised before this deploy, so
			// non-canonical rows are the expected production state — same
			// raw-preferring, live-only fallback as `deleteFile`.
			const storedPath =
				raw !== path && this.liveAssetRowExists(raw) ? raw : path;
			softDeleteAsset(this.sql, { path: storedPath, deviceId: args.deviceId });
		} catch (error) {
			return toRpcError(error);
		}
		const version = bumpVersion(this.sql);
		broadcastVersion(this.ctx, version);
		return { ok: true, version };
	}

	// --- Devices (R3) ---

	registerDeviceSlot(deviceId: string, label?: string): DeviceRow {
		return registerDevice(this.sql, deviceId, label);
	}

	// --- Orphan asset GC (R5), invoked by the Worker's cron handler ---

	listAssetsForGc() {
		return listAllAssetsForGc(this.sql);
	}

	referencedHashes(): string[] {
		return [...referencedHashesInWorkspace(this.sql)];
	}

	markOrphaned(path: string, orphanedAt: number): void {
		markAssetOrphaned(this.sql, path, orphanedAt);
	}

	clearOrphaned(path: string): void {
		clearAssetOrphaned(this.sql, path);
	}

	markDeletedByGc(path: string, deviceId: string): void {
		markAssetDeletedByGc(this.sql, path, deviceId);
	}

	// --- Workspace deletion (R36's charter gap) ---

	/**
	 * Wipes every row this workspace owns -- files, assets, versions,
	 * devices, meta -- and any other Durable Object storage. `deleteAll()`
	 * drops the underlying SQLite tables entirely (not just their rows), so
	 * schema is immediately recreated to leave this DO instance in exactly
	 * the state a brand-new one would be in: empty, but queryable. Called
	 * from deleteWorkspace.ts AFTER that caller has already read
	 * `referencedHashes()` for the cross-workspace R2 refcount check --
	 * order matters, this method destroys the very data that check reads.
	 * Idempotent: wiping an already-empty DO is a no-op.
	 */
	async deleteAllData(): Promise<void> {
		await this.ctx.storage.deleteAll();
		ensureSchema(this.sql);
	}

	// --- Storage cap (R7) ---

	private assertWithinStorageCap(incomingBytes: number): void {
		const cap = workspaceStorageCapBytes(this.env);
		const current = approximateWorkspaceBytes(this.sql);
		if (current + incomingBytes > cap) {
			throw new StorageCapExceededError(current + incomingBytes, cap);
		}
	}
}
