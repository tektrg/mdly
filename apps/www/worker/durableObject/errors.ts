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
	| "ASSET_REFERENCE_ERROR";

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
		error instanceof AssetReferenceError
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
	return {
		ok: false,
		code: "UNKNOWN",
		message: error instanceof Error ? error.message : String(error),
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
	if (isStorageFullError(error)) {
		return {
			status: 413,
			body: {
				error: "Workspace storage is full.",
				code: "STORAGE_CAP_EXCEEDED",
			},
		};
	}
	const message = error instanceof Error ? error.message : String(error);
	return { status: 500, body: { error: message } };
}
