import type { Env } from "../env.js";
import { json, readJsonBody } from "../http.js";
import { workspaceStub } from "./workspaceStub.js";

export function assetR2Key(hash: string): string {
	return `assets/${hash}`;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** GET /api/assets?workspaceId=&since= — SyncBackend.getAssets. */
export async function handleGetAssets(
	request: Request,
	env: Env,
): Promise<Response> {
	const url = new URL(request.url);
	const workspaceId = url.searchParams.get("workspaceId");
	if (!workspaceId)
		return json({ error: "workspaceId is required" }, { status: 400 });
	const sinceParam = url.searchParams.get("since");
	const assets = await workspaceStub(env, workspaceId).listAssets(
		sinceParam ? Number(sinceParam) : undefined,
	);
	return json({ assets });
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
	if (!body?.workspaceId || !body.path || !body.storageId || !body.deviceId) {
		return json(
			{ error: "workspaceId, path, storageId and deviceId are required" },
			{ status: 400 },
		);
	}

	const head = await env.ASSET_BUCKET.head(assetR2Key(body.storageId));
	if (!head) {
		return json(
			{
				error: `No uploaded object found for storageId "${body.storageId}" — upload before pushAsset.`,
				code: "ASSET_REFERENCE_ERROR",
			},
			{ status: 409 },
		);
	}

	const result = await workspaceStub(env, body.workspaceId).pushAsset({
		path: body.path,
		hash: body.storageId,
		deviceId: body.deviceId,
	});
	if (!result.ok) {
		return json({ error: result.message, code: result.code }, { status: 500 });
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
	if (!body?.workspaceId || !body.path || !body.deviceId) {
		return json(
			{ error: "workspaceId, path and deviceId are required" },
			{ status: 400 },
		);
	}
	const result = await workspaceStub(env, body.workspaceId).deleteAsset({
		path: body.path,
		deviceId: body.deviceId,
	});
	return json({ ok: true, version: result.version });
}
