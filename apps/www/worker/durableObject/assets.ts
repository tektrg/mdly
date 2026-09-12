import { utf8ByteLength } from "../http.js";
import {
	escapedBytes,
	MAX_LIST_PAGE_BYTES,
	MAX_LIST_PAGE_ROWS,
	PAGE_ENVELOPE_BYTES,
} from "./files.js";

export type AssetRow = {
	path: string;
	hash: string;
	updatedAt: number;
	orphanedAt: number | null;
	deviceId: string;
	deleted: number;
};

export type RemoteAssetLike = {
	_id: string;
	path: string;
	storageId: string;
	contentHash: string;
	updatedAt: number;
	deviceId: string;
	deleted: boolean;
};

function toRemoteAsset(row: AssetRow): RemoteAssetLike {
	return {
		_id: row.path,
		path: row.path,
		// storageId and contentHash are the same content-addressed sha256 in
		// this backend (R2 key = `assets/<sha256>`) — kept as two fields only
		// to match the existing SyncBackend/RemoteAsset shape byte-for-byte.
		storageId: row.hash,
		contentHash: row.hash,
		updatedAt: row.updatedAt,
		deviceId: row.deviceId,
		deleted: row.deleted === 1,
	};
}

export type AssetCursor = { updatedAt: number; path: string };
export type AssetPage = {
	assets: RemoteAssetLike[];
	nextCursor: AssetCursor | null;
};

type AssetMetaRow = {
	updatedAt: number;
	path: string;
	pathEsc: number;
	hashEsc: number;
	deviceEsc: number;
};

/**
 * Byte-bounded page of the asset listing — same keyset protocol as
 * `listFilesPage` (see it for why). Asset rows carry no content column, so
 * the budget counts path + hash bytes plus the per-row envelope allowance.
 * Unlike files there is no deleted filter: every row is listed.
 */
export function listAssetsPage(
	sql: SqlStorage,
	opts?: {
		since?: number;
		cursor?: AssetCursor | null;
		maxBytes?: number;
	},
): AssetPage {
	const budget =
		opts?.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : MAX_LIST_PAGE_BYTES;
	const cursor = opts?.cursor ?? null;
	const since = opts?.since ?? -1;

	const meta = sql
		.exec<AssetMetaRow>(
			`SELECT updatedAt, path,
				${escapedBytes("path")} AS pathEsc,
				${escapedBytes("hash")} AS hashEsc,
				${escapedBytes("deviceId")} AS deviceEsc
			 FROM assets
			 WHERE updatedAt > ?
			 AND ((updatedAt > ?) OR (updatedAt = ? AND path > ?))
			 ORDER BY updatedAt ASC, path ASC
			 LIMIT ${MAX_LIST_PAGE_ROWS + 1}`,
			since,
			cursor?.updatedAt ?? -1,
			cursor?.updatedAt ?? -1,
			cursor?.path ?? "",
		)
		.toArray();

	let bytes = 0;
	let take = 0;
	for (const row of meta) {
		// Emitted per row: path twice (`_id`, `path`), hash twice
		// (`storageId`, `contentHash`), deviceId once, plus the envelope —
		// all in exact escaped wire bytes.
		const rowBytes =
			2 * row.pathEsc + 2 * row.hashEsc + row.deviceEsc + PAGE_ENVELOPE_BYTES;
		if (take > 0 && (take >= MAX_LIST_PAGE_ROWS || bytes + rowBytes > budget))
			break;
		bytes += rowBytes;
		take++;
	}
	const page = meta.slice(0, take);
	if (page.length === 0) return { assets: [], nextCursor: null };

	const endKey = take < meta.length ? meta[take] : null;
	const endPred = endKey
		? `AND ((updatedAt < ?) OR (updatedAt = ? AND path < ?))`
		: ``;
	const endParams = endKey
		? [endKey.updatedAt, endKey.updatedAt, endKey.path]
		: [];
	const rows = sql
		.exec<AssetRow>(
			`SELECT * FROM assets
			 WHERE updatedAt > ?
			 AND ((updatedAt > ?) OR (updatedAt = ? AND path > ?))
			 ${endPred}
			 ORDER BY updatedAt ASC, path ASC`,
			since,
			cursor?.updatedAt ?? -1,
			cursor?.updatedAt ?? -1,
			cursor?.path ?? "",
			...endParams,
		)
		.toArray();

	const last = page[page.length - 1];
	if (!last) return { assets: [], nextCursor: null };
	return {
		assets: rows.map(toRemoteAsset),
		nextCursor:
			take < meta.length
				? { updatedAt: last.updatedAt, path: last.path }
				: null,
	};
}

/**
 * Upserts an asset row. The caller (the Worker's asset-upload route) must
 * have already confirmed the R2 object for `hash` exists before calling this
 * — see worker/routes/assets.ts — so a committed row can never point at
 * bytes that were never written (R6). No `await` between read and write, for
 * the same last-write-wins-without-corruption reason as `upsertFile` (R8).
 */
export function upsertAsset(
	sql: SqlStorage,
	args: { path: string; hash: string; deviceId: string },
): void {
	const now = Date.now();
	sql.exec(
		`INSERT INTO assets (path, hash, updatedAt, orphanedAt, deviceId, deleted)
		 VALUES (?, ?, ?, NULL, ?, 0)
		 ON CONFLICT(path) DO UPDATE SET
			hash = excluded.hash,
			updatedAt = excluded.updatedAt,
			orphanedAt = NULL,
			deviceId = excluded.deviceId,
			deleted = 0`,
		args.path,
		args.hash,
		now,
		args.deviceId,
	);
}

/**
 * Marks an asset deleted. Deliberately does NOT touch R2 (unlike the old
 * Convex `softDeleteAsset`, which eagerly deleted its 1:1 storage blob) —
 * assets are content-addressed here (R2 key = sha256), so the same hash can
 * be shared across paths/workspaces. R2 cleanup is exclusively the cron's
 * job (R5), which only deletes a hash once no `versions`/`assets` row
 * anywhere still references it.
 */
export function softDeleteAsset(
	sql: SqlStorage,
	args: { path: string; deviceId: string },
): void {
	sql.exec(
		`UPDATE assets SET deleted = 1, updatedAt = ?, deviceId = ? WHERE path = ?`,
		Date.now(),
		args.deviceId,
		args.path,
	);
}

export type GcAssetCursor = { path: string };
export type GcAssetPage = {
	assets: { path: string; deleted: boolean; orphanedAt?: number }[];
	nextCursor: GcAssetCursor | null;
};

/**
 * Byte-bounded page of the GC scan. GC rows carry no content, but the row
 * COUNT is unbounded in principle, so this pages exactly like the listings
 * (keyset on path — rows are already path-ordered small metadata, so the
 * scan doubles as its own metadata pass). Always at least one row per page.
 */
export function listAssetsForGcPage(
	sql: SqlStorage,
	opts?: { cursor?: GcAssetCursor | null; maxBytes?: number },
): GcAssetPage {
	const budget =
		opts?.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : MAX_LIST_PAGE_BYTES;
	const cursor = opts?.cursor ?? null;

	const rows = sql
		.exec<AssetRow>(
			`SELECT * FROM assets WHERE path > ? ORDER BY path ASC LIMIT ${MAX_LIST_PAGE_ROWS + 1}`,
			cursor?.path ?? "",
		)
		.toArray();

	let bytes = 0;
	let take = 0;
	for (const row of rows) {
		const rowBytes =
			utf8ByteLength(row.path) + utf8ByteLength(row.hash) + PAGE_ENVELOPE_BYTES;
		if (take > 0 && (take >= MAX_LIST_PAGE_ROWS || bytes + rowBytes > budget))
			break;
		bytes += rowBytes;
		take++;
	}
	const page = rows.slice(0, take);
	if (page.length === 0) return { assets: [], nextCursor: null };

	const last = page[page.length - 1];
	if (!last) return { assets: [], nextCursor: null };
	return {
		assets: page.map((row) => ({
			path: row.path,
			deleted: row.deleted === 1,
			orphanedAt: row.orphanedAt ?? undefined,
		})),
		nextCursor: take < rows.length ? { path: last.path } : null,
	};
}

export function markAssetOrphaned(
	sql: SqlStorage,
	path: string,
	orphanedAt: number,
): void {
	sql.exec(`UPDATE assets SET orphanedAt = ? WHERE path = ?`, orphanedAt, path);
}

export function clearAssetOrphaned(sql: SqlStorage, path: string): void {
	sql.exec(`UPDATE assets SET orphanedAt = NULL WHERE path = ?`, path);
}

export function markAssetDeletedByGc(
	sql: SqlStorage,
	path: string,
	deviceId: string,
): void {
	sql.exec(
		`UPDATE assets SET deleted = 1, updatedAt = ?, deviceId = ? WHERE path = ?`,
		Date.now(),
		deviceId,
		path,
	);
}

/** Every hash still referenced by a live (non-deleted) row in this workspace — for the cron's cross-workspace refcount check (R5). */
export function referencedHashesInWorkspace(sql: SqlStorage): Set<string> {
	const hashes = new Set<string>();
	for (const row of sql.exec<{ hash: string }>(
		`SELECT hash FROM assets WHERE deleted = 0`,
	)) {
		hashes.add(row.hash);
	}
	for (const row of sql.exec<{ hash: string }>(
		`SELECT DISTINCT hash FROM versions`,
	)) {
		hashes.add(row.hash);
	}
	return hashes;
}
