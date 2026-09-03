/**
 * Distinct, typed errors the DO can throw so the Worker (and eventually the
 * desktop sync-status indicator, per R7) can tell one failure mode from
 * another instead of collapsing everything into a bare 500.
 *
 * These are thrown and caught WITHIN the DO's own method bodies (a single JS
 * realm) and converted to a plain `{ ok: false, code, message }` result
 * before crossing the Workers RPC boundary back to the Worker — RPC's
 * structured-clone-style error serialization does not reliably preserve
 * custom subclass fields like `.code`, so relying on `instanceof` on the
 * caller side of an RPC call would be fragile. See `toRpcError` below.
 */

export type WorkerErrorCode =
	| "STORAGE_CAP_EXCEEDED"
	| "SLOT_INVARIANT_VIOLATION"
	| "ASSET_REFERENCE_ERROR"
	| "BATCH_TOO_LARGE"
	| "BATCH_EMPTY"
	| "BATCH_BYTE_LIMIT"
	| "FILE_TOO_LARGE"
	| "REQUEST_TOO_LARGE"
	| "INVALID_PATH";

export class StorageCapExceededError extends Error {
	readonly code = "STORAGE_CAP_EXCEEDED" as const;
	constructor(
		public readonly workspaceBytes: number,
		public readonly capBytes: number,
	) {
		super(
			`Workspace storage cap exceeded: ${workspaceBytes} bytes would exceed the ${capBytes}-byte cap`,
		);
		this.name = "StorageCapExceededError";
	}
}

export class SlotInvariantViolationError extends Error {
	readonly code = "SLOT_INVARIANT_VIOLATION" as const;
	constructor(message: string) {
		super(message);
		this.name = "SlotInvariantViolationError";
	}
}

export class AssetReferenceError extends Error {
	readonly code = "ASSET_REFERENCE_ERROR" as const;
	constructor(message: string) {
		super(message);
		this.name = "AssetReferenceError";
	}
}

export class BatchTooLargeError extends Error {
	readonly code = "BATCH_TOO_LARGE" as const;
	constructor(
		public readonly fileCount: number,
		public readonly maxFiles: number,
	) {
		super(
			`Batch of ${fileCount} files exceeds the maximum batch size of ${maxFiles} files — split it into smaller batches.`,
		);
		this.name = "BatchTooLargeError";
	}
}

export class BatchEmptyError extends Error {
	readonly code = "BATCH_EMPTY" as const;
	constructor() {
		super("Batch contains no files — nothing to push.");
		this.name = "BatchEmptyError";
	}
}

export class BatchByteLimitError extends Error {
	readonly code = "BATCH_BYTE_LIMIT" as const;
	constructor(
		public readonly totalBytes: number,
		public readonly maxBytes: number,
	) {
		super(
			`Batch payload of ${totalBytes} bytes exceeds the maximum batch size of ${maxBytes} bytes — split it into smaller batches.`,
		);
		this.name = "BatchByteLimitError";
	}
}

export class InvalidPathError extends Error {
	readonly code = "INVALID_PATH" as const;
	constructor(public readonly path: string) {
		super(
			`Invalid file path "${path}" — paths must be non-empty and stay inside the workspace.`,
		);
		this.name = "InvalidPathError";
	}
}

export class FileTooLargeError extends Error {
	readonly code = "FILE_TOO_LARGE" as const;
	constructor(
		public readonly contentBytes: number,
		public readonly maxBytes: number,
	) {
		super(
			`File content of ${contentBytes} bytes exceeds the maximum single-push size of ${maxBytes} bytes — split the file or push it in smaller batches.`,
		);
		this.name = "FileTooLargeError";
	}
}

export class RequestTooLargeError extends Error {
	readonly code = "REQUEST_TOO_LARGE" as const;
	constructor(
		public readonly requestBytes: number,
		public readonly maxBytes: number,
	) {
		super(
			`Request body of ${requestBytes} bytes exceeds the maximum request size of ${maxBytes} bytes.`,
		);
		this.name = "RequestTooLargeError";
	}
}

/** True when the underlying SQLite storage itself reports being full — the DO's real 10GB hard wall, as a fallback safety net behind the app-level cap check. */
export function isStorageFullError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return /database or disk is full|storage limit|out of storage/i.test(
		error.message,
	);
}

/** Converts a thrown error into a plain, RPC-safe tagged result. */
export function toRpcError(error: unknown): {
	ok: false;
	code: WorkerErrorCode | "UNKNOWN";
	message: string;
} {
	if (
		error instanceof StorageCapExceededError ||
		error instanceof SlotInvariantViolationError ||
		error instanceof AssetReferenceError ||
		error instanceof BatchTooLargeError ||
		error instanceof BatchEmptyError ||
		error instanceof BatchByteLimitError ||
		error instanceof FileTooLargeError ||
		error instanceof RequestTooLargeError ||
		error instanceof InvalidPathError
	) {
		return { ok: false, code: error.code, message: error.message };
	}
	if (isStorageFullError(error)) {
		return {
			ok: false,
			code: "STORAGE_CAP_EXCEEDED",
			message: "Workspace storage is full.",
		};
	}
	// UNKNOWN: never leak the raw message (it can carry RPC internals or
	// storage paths). The detail goes to the Worker logs server-side.
	console.error("[worker] unhandled Durable Object error:", error);
	return {
		ok: false,
		code: "UNKNOWN",
		message: "Internal error — the operation failed.",
	};
}

export function errorToResponseBody(error: unknown): {
	status: number;
	body: { error: string; code?: string };
} {
	if (error instanceof StorageCapExceededError) {
		return { status: 413, body: { error: error.message, code: error.code } };
	}
	if (error instanceof SlotInvariantViolationError) {
		return { status: 403, body: { error: error.message, code: error.code } };
	}
	if (error instanceof AssetReferenceError) {
		return { status: 409, body: { error: error.message, code: error.code } };
	}
	if (error instanceof BatchTooLargeError) {
		return { status: 400, body: { error: error.message, code: error.code } };
	}
	if (error instanceof BatchEmptyError) {
		return { status: 400, body: { error: error.message, code: error.code } };
	}
	if (error instanceof BatchByteLimitError) {
		return { status: 413, body: { error: error.message, code: error.code } };
	}
	if (error instanceof InvalidPathError) {
		return { status: 400, body: { error: error.message, code: error.code } };
	}
	if (error instanceof FileTooLargeError) {
		return { status: 413, body: { error: error.message, code: error.code } };
	}
	if (error instanceof RequestTooLargeError) {
		return { status: 413, body: { error: error.message, code: error.code } };
	}
	if (isStorageFullError(error)) {
		return {
			status: 413,
			body: {
				error: "Workspace storage is full.",
				code: "STORAGE_CAP_EXCEEDED",
			},
		};
	}
	// Same UNKNOWN policy as `toRpcError`: generic message to the client,
	// detail to the server logs.
	console.error("[worker] unhandled Worker error:", error);
	return { status: 500, body: { error: "Internal error." } };
}
