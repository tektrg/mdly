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

export function getAssets(sql: SqlStorage, since?: number): RemoteAssetLike[] {
	const rows =
		since !== undefined
			? sql
					.exec<AssetRow>(
						`SELECT * FROM assets WHERE updatedAt > ? ORDER BY updatedAt ASC`,
						since,
					)
					.toArray()
			: sql
					.exec<AssetRow>(`SELECT * FROM assets ORDER BY updatedAt ASC`)
					.toArray();
	return rows.map(toRemoteAsset);
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

export function listAllAssetsForGc(
	sql: SqlStorage,
): { path: string; deleted: boolean; orphanedAt?: number }[] {
	return sql
		.exec<AssetRow>(`SELECT * FROM assets`)
		.toArray()
		.map((row) => ({
			path: row.path,
			deleted: row.deleted === 1,
			orphanedAt: row.orphanedAt ?? undefined,
		}));
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
