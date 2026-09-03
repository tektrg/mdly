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

export type { RemoteAssetLike } from "./assets.js";
export type { RemoteFileLike } from "./files.js";

export type PushResult =
	| { ok: true; version: number }
	| { ok: false; code: WorkerErrorCode | "UNKNOWN"; message: string };

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
		try {
			assertCommentLogSlotInvariant(this.sql, args.path, args.deviceId);
			this.assertWithinStorageCap(args.content.length);
		} catch (error) {
			return toRpcError(error);
		}

		upsertFile(this.sql, args);
		const version = bumpVersion(this.sql);
		broadcastVersion(this.ctx, version);
		return { ok: true, version };
	}

	deleteFile(args: { path: string; deviceId: string }): { version: number } {
		softDeleteFile(this.sql, args);
		const version = bumpVersion(this.sql);
		broadcastVersion(this.ctx, version);
		return { version };
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
		upsertAsset(this.sql, args);
		const version = bumpVersion(this.sql);
		broadcastVersion(this.ctx, version);
		return { ok: true, version };
	}

	deleteAsset(args: { path: string; deviceId: string }): { version: number } {
		softDeleteAsset(this.sql, args);
		const version = bumpVersion(this.sql);
		broadcastVersion(this.ctx, version);
		return { version };
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
