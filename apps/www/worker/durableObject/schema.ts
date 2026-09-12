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
	// Running total of live file bytes (BUG-LW1 fix). `-1` means "never
	// computed" — see ensureBytesCounter below. A fresh DO backfills on first
	// access (one empty-table scan); a pre-existing deployed DO with rows but
	// no counter backfills once, then serves every later cap check O(1).
	sql.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('bytes', -1)`);
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
	return ensureBytesCounter(sql);
}

/**
 * The running byte total behind `approximateWorkspaceBytes` (BUG-LW1 fix).
 *
 * `SUM(LENGTH(content))` cannot use an index — it scans every row — and the
 * old code ran it on every single file push, making a first sync of N files
 * cost N(N-1)/2 row reads (1.58M rows for a real 1,778-file workspace,
 * against a 5M/day free-tier budget). This counter makes the cap check O(1):
 * one 1-row `meta` read per push, with `upsertFile`/`softDeleteFile`
 * adjusting the total incrementally.
 *
 * Semantics preserved exactly: only live (`deleted = 0`) `files` rows count.
 * Asset rows are metadata-only (their bytes live in R2) and were never part
 * of the sum, so asset writes do not touch this counter.
 */
const BYTES_COUNTER_UNINITIALIZED = -1;

export function ensureBytesCounter(sql: SqlStorage): number {
	const row = sql
		.exec<{ value: number }>(`SELECT value FROM meta WHERE key = 'bytes'`)
		.toArray()[0];
	if (row && row.value !== BYTES_COUNTER_UNINITIALIZED) return row.value;

	// First access since the counter was introduced (or a fresh DO): one
	// full scan, then persist so every later call is a single-row read.
	// Idempotent — safe on an empty DO (SUM over zero rows is NULL → 0) and
	// safe to re-run if a concurrent caller already filled it in.
	const filesRow = sql
		.exec<{ total: number | null }>(
			`SELECT SUM(LENGTH(content)) as total FROM files WHERE deleted = 0`,
		)
		.one();
	const total = filesRow.total ?? 0;
	sql.exec(
		`INSERT INTO meta (key, value) VALUES ('bytes', ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value
		 WHERE meta.value = ${BYTES_COUNTER_UNINITIALIZED}`,
		total,
	);
	return total;
}

/** Adjusts the running byte total by a (possibly negative) delta. Callers must have ensured the counter first; a no-op for zero deltas. */
export function addWorkspaceBytes(sql: SqlStorage, delta: number): void {
	if (delta === 0) return;
	sql.exec(`UPDATE meta SET value = value + ? WHERE key = 'bytes'`, delta);
}
