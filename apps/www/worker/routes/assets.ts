import { FieldTooLargeError } from "../durableObject/errors.js";
import { MAX_FIELD_BYTES } from "../durableObject/workspaceDurableObject.js";
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

function assetErrorStatus(code: string): number {
	if (code === "ASSET_REFERENCE_ERROR") return 409;
	if (code === "SLOT_INVARIANT_VIOLATION") return 403;
	if (code === "INVALID_PATH") return 400;
	if (code === "FIELD_TOO_LARGE") return 413;
	return 500;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** 413 when one scalar field exceeds the SQLite-safe ceiling (see files.ts). */
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

export function assetR2Key(hash: string): string {
	return `assets/${hash}`;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** GET /api/assets?workspaceId=&since=&cursorUpdatedAt=&cursorPath= — SyncBackend.getAssets, one byte-bounded page. */
export async function handleGetAssets(
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
	const page = await workspaceStub(env, workspaceId).listAssets({
		since,
		cursor,
	});
	return json({ assets: page.assets, nextCursor: page.nextCursor });
}

/**
 * POST /api/asset/upload — the target of SyncBackend.generateAssetUploadUrl.
 * Raw bytes in, `{ storageId }` (the content's sha256) out. Writes to R2
 * BEFORE returning, so any subsequent `pushAsset` call naming this
 * `storageId` is guaranteed the object already exists (R6 — see
 * handlePushAsset's existence check below for the other half of that
 * guarantee).
 */
export async function handleAssetUpload(
	request: Request,
	env: Env,
): Promise<Response> {
	const bytes = await request.arrayBuffer();
	const hash = await sha256Hex(bytes);
	await env.ASSET_BUCKET.put(assetR2Key(hash), bytes);
	return json({ storageId: hash });
}

/** GET /api/asset/:hash — the target of SyncBackend.getAssetDownloadUrl. */
export async function handleAssetDownload(
	hash: string,
	env: Env,
): Promise<Response> {
	const object = await env.ASSET_BUCKET.get(assetR2Key(hash));
	if (!object) return new Response(null, { status: 404 });
	return new Response(object.body, {
		headers: { "Content-Type": "application/octet-stream" },
	});
}

/** SyncBackend.generateAssetUploadUrl / getAssetDownloadUrl — both are plain same-origin Worker routes gated by the same auth middleware as everything else under /api/* (R40). */
export function handleGenerateAssetUploadUrl(request: Request): Response {
	const origin = new URL(request.url).origin;
	return json({ uploadUrl: `${origin}/api/asset/upload` });
}

export function handleGetAssetDownloadUrl(
	request: Request,
	hash: string | null,
): Response {
	if (!hash) return json({ url: null });
	const origin = new URL(request.url).origin;
	return json({ url: `${origin}/api/asset/${hash}` });
}

/**
 * POST /api/assets — SyncBackend.pushAsset. Confirms the R2 object named by
 * `storageId` actually exists before letting the DO commit a row that points
 * at it — the other half of R6's "never a dangling reference" guarantee.
 */
export async function handlePushAsset(
	request: Request,
	env: Env,
): Promise<Response> {
	const body = await readJsonBody<{
		workspaceId?: string;
		path?: string;
		storageId?: string;
		contentHash?: string;
		deviceId?: string;
	}>(request);
	const workspaceId = body?.workspaceId;
	const path = body?.path;
	const storageId = body?.storageId;
	const deviceId = body?.deviceId;
	const contentHash = body?.contentHash;
	if (
		!isNonEmptyString(workspaceId) ||
		!isNonEmptyString(path) ||
		!isNonEmptyString(storageId) ||
		!isNonEmptyString(deviceId) ||
		(contentHash !== undefined && typeof contentHash !== "string")
	) {
		return json(
			{
				error:
					"workspaceId, path, storageId and deviceId are required non-empty strings",
			},
			{ status: 400 },
		);
	}
	const tooLarge = requestTooLargeResponse(body);
	if (tooLarge) return tooLarge;
	const badDevice = forbiddenDeviceIdResponse(deviceId);
	if (badDevice) return badDevice;
	const badField =
		oversizedFieldResponse("storageId", storageId) ??
		oversizedFieldResponse("deviceId", deviceId);
	if (badField) return badField;

	const head = await env.ASSET_BUCKET.head(assetR2Key(storageId));
	if (!head) {
		return json(
			{
				error: `No uploaded object found for storageId "${storageId}" — upload before pushAsset.`,
				code: "ASSET_REFERENCE_ERROR",
			},
			{ status: 409 },
		);
	}

	const result = await workspaceStub(env, workspaceId).pushAsset({
		path,
		hash: storageId,
		deviceId,
	});
	if (!result.ok) {
		return json(
			{ error: result.message, code: result.code },
			{ status: assetErrorStatus(result.code) },
		);
	}
	return json({ ok: true, version: result.version });
}

/** POST /api/assets/delete — SyncBackend.softDeleteAsset. */
export async function handleSoftDeleteAsset(
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
	const result = await workspaceStub(env, workspaceId).deleteAsset({
		path,
		deviceId,
	});
	if (!result.ok) {
		return json(
			{ error: result.message, code: result.code },
			{ status: assetErrorStatus(result.code) },
		);
	}
	return json({ ok: true, version: result.version });
}
