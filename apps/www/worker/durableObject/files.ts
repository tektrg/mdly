import { slotForDevice } from "./devices.js";
import { SlotInvariantViolationError } from "./errors.js";
import { addWorkspaceBytes, ensureBytesCounter } from "./schema.js";

export type FileRow = {
	path: string;
	contentHash: string;
	content: string;
	updatedAt: number;
	deviceId: string;
	deleted: number;
};

export type RemoteFileLike = {
	_id: string;
	path: string;
	contentHash: string;
	content: string;
	updatedAt: number;
	deviceId: string;
	deleted: boolean;
};

function toRemoteFile(row: FileRow): RemoteFileLike {
	return {
		_id: row.path,
		path: row.path,
		contentHash: row.contentHash,
		content: row.content,
		updatedAt: row.updatedAt,
		deviceId: row.deviceId,
		deleted: row.deleted === 1,
	};
}

export type FileCursor = { updatedAt: number; path: string };
export type FilePage = {
	files: RemoteFileLike[];
	nextCursor: FileCursor | null;
};

/** Max total content bytes per listing page — far below the ~32MiB RPC ceiling. */
export const MAX_LIST_PAGE_BYTES = 8 * 1024 * 1024;

/**
 * Exact escaped wire bytes of a TEXT column, or a conservative 6x estimate
 * for large values. `json_quote` materialises the escaped string as a SQLite
 * value, which is itself subject to the ~2.2MB per-value ceiling — quoting
 * 2MiB of control characters would throw, so values over 256KiB take the
 * worst-case factor instead (every byte escaping to 6). Small values — the
 * overwhelmingly common case — are measured exactly, keeping pages tight.
 */
const ESCAPED_BYTES_EXPR = `(CASE WHEN LENGTH(CAST(%s AS BLOB)) <= 262144
	THEN LENGTH(CAST(json_quote(%s) AS BLOB)) - 2
	ELSE 6 * LENGTH(CAST(%s AS BLOB)) END)`;

/** Exact escaped wire bytes of a column (see above). */
export function escapedBytes(column: string): string {
	return ESCAPED_BYTES_EXPR.replace(/%s/g, column);
}

/**
 * Max rows per listing page. The byte budget alone cannot bound the
 * response: it takes few enough bytes that thousands of tiny rows still fit,
 * and — worse — the old rowid-IN refetch needed one bound parameter PER ROW
 * against DO SQLite's 100-parameter cap. Both dimensions are always bounded.
 */
export const MAX_LIST_PAGE_ROWS = 500;

/**
 * Fixed JSON envelope bytes per emitted row (keys, punctuation, updatedAt
 * digits, deleted flag, braces) — everything around the measured fields.
 */
export const PAGE_ENVELOPE_BYTES = 128;

type FileMetaRow = {
	updatedAt: number;
	path: string;
	deleted: number;
	contentEsc: number;
	pathBytes: number;
	hashBytes: number;
	deviceBytes: number;
};

/**
 * One byte- AND row-bounded page of the file listing. Pages walk
 * `(updatedAt, path)` order with a keyset cursor, so concurrent inserts /
 * updates between pages can neither duplicate nor permanently skip rows the
 * way OFFSET would: every row matching the filter is eventually emitted
 * exactly once per pass.
 *
 * Two queries per page, both bounded: first a metadata-only scan (no content
 * crosses, capped at one more row than the page maximum), then a keyset
 * RANGE re-fetch of exactly the page's rows — a fixed handful of scalar
 * params, never one bound parameter per row (DO SQLite caps those at 100).
 * A page always carries at least one row when rows remain. `nextCursor` is
 * null when the listing is exhausted.
 */
export function listFilesPage(
	sql: SqlStorage,
	opts?: {
		since?: number;
		includeDeleted?: boolean;
		cursor?: FileCursor | null;
		maxBytes?: number;
	},
): FilePage {
	const budget =
		opts?.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : MAX_LIST_PAGE_BYTES;
	const cursor = opts?.cursor ?? null;
	const includeDeleted = opts?.includeDeleted ?? false;
	const since = opts?.since ?? -1;

	const meta = sql
		.exec<FileMetaRow>(
			`SELECT updatedAt, path, deleted,
				${escapedBytes("content")} AS contentEsc,
				${escapedBytes("path")} AS pathBytes,
				${escapedBytes("contentHash")} AS hashBytes,
				${escapedBytes("deviceId")} AS deviceBytes
			 FROM files
			 WHERE updatedAt > ?
			 ${includeDeleted ? "" : "AND deleted = 0"}
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
		// Exact response cost in wire bytes: json_quote measures the escaped
		// form (a control char costs 6, astral text costs 4/char), so an 8MiB
		// budget can never admit a 32MiB payload the way a character count
		// does. Path is emitted twice (`_id`, `path`).
		const rowBytes =
			row.contentEsc +
			2 * row.pathBytes +
			row.hashBytes +
			row.deviceBytes +
			PAGE_ENVELOPE_BYTES;
		if (take > 0 && (take >= MAX_LIST_PAGE_ROWS || bytes + rowBytes > budget))
			break;
		bytes += rowBytes;
		take++;
	}
	const page = meta.slice(0, take);
	if (page.length === 0) return { files: [], nextCursor: null };

	// Range re-fetch: same predicates, bounded end key — a fixed 6 scalar
	// params, never one per row (DO SQLite caps bound parameters at 100).
	// Adjacent sync sql.exec calls cannot interleave with other writers, so
	// the metadata and the fetch observe the same table state.
	const endKey = take < meta.length ? meta[take] : null;
	const endPred = endKey
		? `AND ((updatedAt < ?) OR (updatedAt = ? AND path < ?))`
		: ``;
	const endParams = endKey
		? [endKey.updatedAt, endKey.updatedAt, endKey.path]
		: [];
	const rows = sql
		.exec<FileRow>(
			`SELECT * FROM files
			 WHERE updatedAt > ?
			 ${includeDeleted ? "" : "AND deleted = 0"}
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
	if (!last) return { files: [], nextCursor: null };
	return {
		files: rows.map(toRemoteFile),
		nextCursor:
			take < meta.length
				? { updatedAt: last.updatedAt, path: last.path }
				: null,
	};
}

/**
 * Server-enforced comment-log slot invariant (R4). `.mdly/comments/<base>
 * <n>.jsonl` may only be written by the device registered for slot `n`;
 * `.mdly/comments/<base>.jsonl` (canonical, unsuffixed) may only be written
 * by a caller that has NEVER registered a slot — i.e. the desktop app or CLI
 * (R3: browsers always register; desktop/CLI never do), matching "the
 * desktop app owns the canonical log" from the spec.
 *
 * Paths reaching here are already normalised (`canonicalFilePath` in the
 * DO — structural `.`/`..`/slash collapsing only, byte-preserving within
 * segments), so the stored path is the checked path: `note.jsonl ` is simply
 * a different, harmless file from `note.jsonl`, never a bypass. The `.jsonl`
 * extension matches case-insensitively.
 */
const COMMENT_LOG_PATTERN = /^\.mdly\/comments\/(.+?)(?: (\d+))?\.jsonl$/i;

export function assertCommentLogSlotInvariant(
	sql: SqlStorage,
	path: string,
	deviceId: string,
): void {
	const match = COMMENT_LOG_PATTERN.exec(path);
	if (!match) return; // not a comment log — no invariant to enforce

	const suffixSlot = match[2] !== undefined ? Number(match[2]) : null;
	const registeredSlot = slotForDevice(sql, deviceId);

	if (suffixSlot === null) {
		if (registeredSlot !== null) {
			throw new SlotInvariantViolationError(
				`Device ${deviceId} is a registered browser (slot ${registeredSlot}) and cannot write the canonical comment log "${path}".`,
			);
		}
		return; // unregistered caller (desktop/CLI) writing the canonical log — allowed
	}

	if (registeredSlot !== suffixSlot) {
		throw new SlotInvariantViolationError(
			`Device ${deviceId}'s registered slot (${registeredSlot ?? "none"}) does not match the slot suffix ${suffixSlot} on "${path}".`,
		);
	}
}

/**
 * Upserts a file row. Zero `await`s between the read and the write, so two
 * concurrent pushes to the same path (R8) can never interleave mid-update
 * within a single DO instance — the DO's single-threaded JS execution model
 * plus this synchronous SQLite API is what makes "no error thrown, last
 * write deterministically wins" true rather than merely likely.
 *
 * Also maintains the running byte total for the storage-cap check (BUG-LW1):
 * reads the OLD row by primary key (O(1)) to compute the delta, then adjusts
 * the counter — never a table scan. Lengths use SQLite `LENGTH()` semantics
 * (via `SELECT LENGTH(?)`), not JS `.length`, so the counter matches
 * `SUM(LENGTH(content))` exactly even for non-BMP text (emoji), where the
 * two disagree (UTF-16 code units vs code points). `SELECT LENGTH(?)` reads
 * zero table rows.
 */
export function upsertFile(
	sql: SqlStorage,
	args: {
		path: string;
		contentHash: string;
		content: string;
		deviceId: string;
	},
): void {
	ensureBytesCounter(sql);
	const old = sql
		.exec<{ len: number; deleted: number }>(
			`SELECT LENGTH(content) AS len, deleted FROM files WHERE path = ?`,
			args.path,
		)
		.toArray()[0];
	const oldBytes = old && old.deleted === 0 ? old.len : 0;
	const now = Date.now();
	sql.exec(
		`INSERT INTO files (path, contentHash, content, updatedAt, deviceId, deleted)
		 VALUES (?, ?, ?, ?, ?, 0)
		 ON CONFLICT(path) DO UPDATE SET
			contentHash = excluded.contentHash,
			content = excluded.content,
			updatedAt = excluded.updatedAt,
			deviceId = excluded.deviceId,
			deleted = 0`,
		args.path,
		args.contentHash,
		args.content,
		now,
		args.deviceId,
	);
	const newBytes = sql
		.exec<{ len: number }>(`SELECT LENGTH(?) AS len`, args.content)
		.one().len;
	addWorkspaceBytes(sql, newBytes - oldBytes);
}

export function softDeleteFile(
	sql: SqlStorage,
	args: { path: string; deviceId: string },
): void {
	ensureBytesCounter(sql);
	const old = sql
		.exec<{ len: number; deleted: number }>(
			`SELECT LENGTH(content) AS len, deleted FROM files WHERE path = ?`,
			args.path,
		)
		.toArray()[0];
	sql.exec(
		`UPDATE files SET deleted = 1, updatedAt = ?, deviceId = ? WHERE path = ?`,
		Date.now(),
		args.deviceId,
		args.path,
	);
	// Only a live row leaving the live set shrinks the total: deleting an
	// already-deleted or nonexistent path changes nothing.
	if (old && old.deleted === 0) addWorkspaceBytes(sql, -old.len);
}
