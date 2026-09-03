import { slotForDevice } from "./devices.js";
import { SlotInvariantViolationError } from "./errors.js";

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
 */
const COMMENT_LOG_PATTERN = /^\.mdly\/comments\/(.+?)(?: (\d+))?\.jsonl$/;

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
}

export function softDeleteFile(
	sql: SqlStorage,
	args: { path: string; deviceId: string },
): void {
	sql.exec(
		`UPDATE files SET deleted = 1, updatedAt = ?, deviceId = ? WHERE path = ?`,
		Date.now(),
		args.deviceId,
		args.path,
	);
}
