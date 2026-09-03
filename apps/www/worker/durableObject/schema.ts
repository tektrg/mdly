/**
 * DO SQLite schema — see docs/plans/cloud-review-surface.md's "Data model
 * (DO SQLite)" table. Phase 1 (this delivery) does not populate `versions`
 * (R2 version store is Phase 2 scope) but the table is created now so the
 * schema doesn't need a second migration when that lands.
 */
export function ensureSchema(sql: SqlStorage): void {
	sql.exec(`
		CREATE TABLE IF NOT EXISTS files (
			path TEXT PRIMARY KEY,
			contentHash TEXT NOT NULL,
			content TEXT NOT NULL,
			updatedAt INTEGER NOT NULL,
			deviceId TEXT NOT NULL,
			deleted INTEGER NOT NULL DEFAULT 0
		)
	`);
	sql.exec(`CREATE INDEX IF NOT EXISTS files_updatedAt ON files (updatedAt)`);

	sql.exec(`
		CREATE TABLE IF NOT EXISTS assets (
			path TEXT PRIMARY KEY,
			hash TEXT NOT NULL,
			updatedAt INTEGER NOT NULL,
			orphanedAt INTEGER,
			deviceId TEXT NOT NULL,
			deleted INTEGER NOT NULL DEFAULT 0
		)
	`);
	sql.exec(`CREATE INDEX IF NOT EXISTS assets_updatedAt ON assets (updatedAt)`);

	sql.exec(`
		CREATE TABLE IF NOT EXISTS versions (
			path TEXT NOT NULL,
			hash TEXT NOT NULL,
			at INTEGER NOT NULL,
			deviceId TEXT NOT NULL
		)
	`);
	sql.exec(
		`CREATE INDEX IF NOT EXISTS versions_path_at ON versions (path, at DESC)`,
	);

	sql.exec(`
		CREATE TABLE IF NOT EXISTS devices (
			deviceId TEXT PRIMARY KEY,
			slot INTEGER UNIQUE,
			label TEXT,
			firstSeenAt INTEGER NOT NULL,
			lastSeenAt INTEGER NOT NULL
		)
	`);

	sql.exec(`
		CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value INTEGER NOT NULL
		)
	`);
	sql.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('version', 0)`);
}

export function currentVersion(sql: SqlStorage): number {
	const row = sql
		.exec<{ value: number }>(`SELECT value FROM meta WHERE key = 'version'`)
		.one();
	return row.value;
}

/** Bumps and returns the new per-workspace version counter (R2). */
export function bumpVersion(sql: SqlStorage): number {
	sql.exec(`UPDATE meta SET value = value + 1 WHERE key = 'version'`);
	return currentVersion(sql);
}

/** Approximate total bytes stored for this workspace — files' content plus a fixed row overhead estimate. Used for the app-level storage cap check (R7), not an exact accounting. */
export function approximateWorkspaceBytes(sql: SqlStorage): number {
	const filesRow = sql
		.exec<{ total: number | null }>(
			`SELECT SUM(LENGTH(content)) as total FROM files WHERE deleted = 0`,
		)
		.one();
	return filesRow.total ?? 0;
}
