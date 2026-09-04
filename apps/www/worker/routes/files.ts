import {
	BatchByteLimitError,
	BatchTooLargeError,
	FieldTooLargeError,
	FileTooLargeError,
} from "../durableObject/errors.js";
import {
	MAX_FIELD_BYTES,
	MAX_PUSH_BATCH_BYTES,
	MAX_PUSH_BATCH_FILES,
	MAX_PUSH_FILE_BYTES,
} from "../durableObject/workspaceDurableObject.js";
import type { Env } from "../env.js";
import {
	forbiddenDeviceIdResponse,
	json,
	parseCursor,
	readJsonBody,
	requestTooLargeResponse,
	utf8ByteLength,
} from "../http.js";
import { workspaceStub } from "./workspaceStub.js";

function pushErrorStatus(code: string): number {
	if (code === "STORAGE_CAP_EXCEEDED") return 413;
	if (code === "SLOT_INVARIANT_VIOLATION") return 403;
	if (code === "BATCH_TOO_LARGE") return 400;
	if (code === "BATCH_EMPTY") return 400;
	if (code === "BATCH_BYTE_LIMIT") return 413;
	if (code === "FILE_TOO_LARGE") return 413;
	if (code === "REQUEST_TOO_LARGE") return 413;
	if (code === "FIELD_TOO_LARGE") return 413;
	if (code === "INVALID_PATH") return 400;
	return 500;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/**
 * 413 when one scalar field exceeds the SQLite-safe ceiling (pre-RPC, so an
 * oversized contentHash/deviceId can never 500 mid-write and be retried as
 * transient forever). Returns null when clean.
 */
function oversizedFieldResponse(field: string, value: string): Response | null {
	const bytes = utf8ByteLength(value);
	if (bytes > MAX_FIELD_BYTES) {
		const error = new FieldTooLargeError(field, bytes, MAX_FIELD_BYTES);
		return json(
			{ error: error.message, code: error.code },
			{ status: 413 },
		);
	}
	return null;
}

/**
 * GET /api/version?workspaceId= — cheap change check (BUG-LW1 Task 3). Reads
 * a single `meta` row (the same counter `pushFile` bumps and the WebSocket
 * broadcast carries), so a client can skip `GET /api/files?since=...`
 * entirely when the version hasn't moved — that listing otherwise re-reads
 * every row changed since the timestamp, including rows the client itself
 * just wrote.
 */
export async function handleGetVersion(
	request: Request,
	env: Env,
): Promise<Response> {
	const url = new URL(request.url);
	const workspaceId = url.searchParams.get("workspaceId");
	if (!workspaceId)
		return json({ error: "workspaceId is required" }, { status: 400 });
	const version = await workspaceStub(env, workspaceId).getVersion();
	return json({ version });
}

/** GET /api/files?workspaceId=&since=&includeDeleted=&cursorUpdatedAt=&cursorPath= — SyncBackend.getFiles, one byte-bounded page. */
export async function handleGetFiles(
	request: Request,
	env: Env,
): Promise<Response> {
	const url = new URL(request.url);
	const workspaceId = url.searchParams.get("workspaceId");
	if (!workspaceId)
		return json({ error: "workspaceId is required" }, { status: 400 });

	const sinceParam = url.searchParams.get("since");
	const since = sinceParam ? Number(sinceParam) : undefined;
	if (since !== undefined && !Number.isFinite(since)) {
		return json(
			{ error: "since must be a valid timestamp number" },
			{ status: 400 },
		);
	}
	const cursor = parseCursor(
		url.searchParams.get("cursorUpdatedAt"),
		url.searchParams.get("cursorPath"),
	);
	if (cursor === "invalid") {
		return json(
			{ error: "cursorUpdatedAt and cursorPath must be passed together and valid" },
			{ status: 400 },
		);
	}
	const opts = {
		since,
		includeDeleted: url.searchParams.get("includeDeleted") === "true",
		cursor,
	};

	const page = await workspaceStub(env, workspaceId).listFiles(opts);
	return json({ files: page.files, nextCursor: page.nextCursor });
}

/** POST /api/files — SyncBackend.pushFile. */
export async function handlePushFile(
	request: Request,
	env: Env,
): Promise<Response> {
	const body = await readJsonBody<{
		workspaceId?: string;
		path?: string;
		contentHash?: string;
		content?: string;
		deviceId?: string;
	}>(request);
	const workspaceId = body?.workspaceId;
	const path = body?.path;
	const content = body?.content;
	const deviceId = body?.deviceId;
	const contentHash = body?.contentHash;
	if (
		!isNonEmptyString(workspaceId) ||
		!isNonEmptyString(path) ||
		!isNonEmptyString(deviceId) ||
		typeof content !== "string" ||
		(contentHash !== undefined && typeof contentHash !== "string")
	) {
		return json(
			{
				error:
					"workspaceId, path and deviceId are required non-empty strings, content is required and must be a string",
			},
			{ status: 400 },
		);
	}

	// Total request size first: every field crosses the RPC boundary, and
	// only `content` has its own cap — a 33MB deviceId would otherwise die
	// inside RPC with a 500 leaking internals.
	const tooLarge = requestTooLargeResponse(body);
	if (tooLarge) return tooLarge;
	const badDevice = forbiddenDeviceIdResponse(deviceId);
	if (badDevice) return badDevice;
	const badField =
		oversizedFieldResponse("contentHash", contentHash ?? "") ??
		oversizedFieldResponse("deviceId", deviceId);
	if (badField) return badField;

	// Pre-RPC guard: a payload near the ~32MiB RPC ceiling would die inside
	// the RPC layer with a 500 leaking internals (same leak the batch byte
	// cap closes). The DO re-checks as defence in depth.
	if (utf8ByteLength(content) > MAX_PUSH_FILE_BYTES) {
		const error = new FileTooLargeError(
			utf8ByteLength(content),
			MAX_PUSH_FILE_BYTES,
			path,
		);
		return json(
			{ error: error.message, code: error.code },
			{ status: 413 },
		);
	}

	const result = await workspaceStub(env, workspaceId).pushFile({
		path,
		contentHash: contentHash ?? "",
		content,
		deviceId,
	});
	if (!result.ok) {
		return json(
			{ error: result.message, code: result.code },
			{ status: pushErrorStatus(result.code) },
		);
	}
	return json({ ok: true, version: result.version });
}

/** POST /api/files/delete — SyncBackend.softDeleteFile. */
export async function handleSoftDeleteFile(
	request: Request,
	env: Env,
): Promise<Response> {
	const body = await readJsonBody<{
		workspaceId?: string;
		path?: string;
		deviceId?: string;
	}>(request);
	const workspaceId = body?.workspaceId;
	const path = body?.path;
	const deviceId = body?.deviceId;
	if (
		!isNonEmptyString(workspaceId) ||
		!isNonEmptyString(path) ||
		!isNonEmptyString(deviceId)
	) {
		return json(
			{
				error:
					"workspaceId, path and deviceId are required non-empty strings",
			},
			{ status: 400 },
		);
	}
	const tooLarge = requestTooLargeResponse(body);
	if (tooLarge) return tooLarge;
	const badDevice = forbiddenDeviceIdResponse(deviceId);
	if (badDevice) return badDevice;
	const badField = oversizedFieldResponse("deviceId", deviceId);
	if (badField) return badField;
	const result = await workspaceStub(env, workspaceId).deleteFile({
		path,
		deviceId,
	});
	if (!result.ok) {
		return json(
			{ error: result.message, code: result.code },
			{ status: pushErrorStatus(result.code) },
		);
	}
	return json({ ok: true, version: result.version });
}

/**
 * POST /api/files/batch — pushes many files with one cap check and one
 * version bump (BUG-LW1 Task 2). The single-file POST /api/files is
 * unchanged (CLI + current desktop client still use it); the client-side
 * switch to batching is a separate change. Each entry carries its own
 * deviceId so per-file slot-invariant enforcement is identical to
 * single-file pushes.
 */
export async function handlePushFilesBatch(
	request: Request,
	env: Env,
): Promise<Response> {
	const body = await readJsonBody<{
		workspaceId?: string;
		files?: {
			path?: string;
			contentHash?: string;
			content?: string;
			deviceId?: string;
		}[];
	}>(request);
	const workspaceId = body?.workspaceId;
	const files = body?.files;
	if (!isNonEmptyString(workspaceId) || !Array.isArray(files)) {
		return json(
			{
				error:
					"workspaceId is required and must be a non-empty string, files must be an array",
			},
			{ status: 400 },
		);
	}
	for (const file of files) {
		const contentHash = file?.contentHash;
		if (
			!isNonEmptyString(file?.path) ||
			!isNonEmptyString(file?.deviceId) ||
			typeof file?.content !== "string" ||
			(contentHash !== undefined && typeof contentHash !== "string")
		) {
			return json(
				{
					error:
						"every file needs path and deviceId as non-empty strings, content as a string, and contentHash as a string when present",
				},
				{ status: 400 },
			);
		}
	}

	// Pre-RPC guards so an oversized batch fails here with a clean error
	// instead of dying inside the RPC call (the DO re-checks both as
	// defence in depth for direct RPC callers). The total-size check comes
	// first: every field crosses the RPC boundary, not just content.
	const tooLarge = requestTooLargeResponse(body);
	if (tooLarge) return tooLarge;
	for (const file of files) {
		const badDevice = forbiddenDeviceIdResponse(file?.deviceId ?? "");
		if (badDevice) return badDevice;
		const badField =
			oversizedFieldResponse("contentHash", file?.contentHash ?? "") ??
			oversizedFieldResponse("deviceId", file?.deviceId ?? "");
		if (badField) return badField;
		// Per-file ceiling pre-RPC, mirroring the DO check: one oversized
		// entry 413s here instead of SQLITE_TOOBIG-ing mid-batch.
		const contentBytes = utf8ByteLength(file?.content ?? "");
		if (contentBytes > MAX_PUSH_FILE_BYTES) {
			const error = new FileTooLargeError(
				contentBytes,
				MAX_PUSH_FILE_BYTES,
				file?.path ?? "",
			);
			return json(
				{ error: error.message, code: error.code },
				{ status: 413 },
			);
		}
	}
	if (files.length > MAX_PUSH_BATCH_FILES) {
		const error = new BatchTooLargeError(files.length, MAX_PUSH_BATCH_FILES);
		return json(
			{ error: error.message, code: error.code },
			{ status: 400 },
		);
	}
	const batchBytes = files.reduce(
		(sum, file) => sum + (file?.content?.length ?? 0),
		0,
	);
	if (batchBytes > MAX_PUSH_BATCH_BYTES) {
		const error = new BatchByteLimitError(batchBytes, MAX_PUSH_BATCH_BYTES);
		return json(
			{ error: error.message, code: error.code },
			{ status: 413 },
		);
	}

	const result = await workspaceStub(env, workspaceId).pushFilesBatch({
		files: files.map((file) => ({
			path: file.path ?? "",
			contentHash: file.contentHash ?? "",
			content: file.content ?? "",
			deviceId: file.deviceId ?? "",
		})),
	});

	if (!result.ok) {
		return json(
			{ error: result.message, code: result.code },
			{ status: pushErrorStatus(result.code) },
		);
	}
	return json({ ok: true, version: result.version });
}
