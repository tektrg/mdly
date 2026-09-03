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

export function getFiles(
	sql: SqlStorage,
	opts?: { since?: number; includeDeleted?: boolean },
): RemoteFileLike[] {
	const rows =
		opts?.since !== undefined
			? sql
					.exec<FileRow>(
						`SELECT * FROM files WHERE updatedAt > ? ORDER BY updatedAt ASC`,
						opts.since,
					)
					.toArray()
			: sql
					.exec<FileRow>(`SELECT * FROM files ORDER BY updatedAt ASC`)
					.toArray();

	const files = rows.map(toRemoteFile);
	return opts?.includeDeleted ? files : files.filter((f) => !f.deleted);
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
