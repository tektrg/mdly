import type { Env } from "../env.js";
import { json, readJsonBody } from "../http.js";
import { workspaceStub } from "./workspaceStub.js";

function pushErrorStatus(code: string): number {
	if (code === "STORAGE_CAP_EXCEEDED") return 413;
	if (code === "SLOT_INVARIANT_VIOLATION") return 403;
	return 500;
}

/** GET /api/files?workspaceId=&since=&includeDeleted= — SyncBackend.getFiles. */
export async function handleGetFiles(
	request: Request,
	env: Env,
): Promise<Response> {
	const url = new URL(request.url);
	const workspaceId = url.searchParams.get("workspaceId");
	if (!workspaceId)
		return json({ error: "workspaceId is required" }, { status: 400 });

	const sinceParam = url.searchParams.get("since");
	const opts = {
		since: sinceParam ? Number(sinceParam) : undefined,
		includeDeleted: url.searchParams.get("includeDeleted") === "true",
	};

	const files = await workspaceStub(env, workspaceId).listFiles(opts);
	return json({ files });
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
	if (
		!body?.workspaceId ||
		!body.path ||
		!body.deviceId ||
		body.content === undefined
	) {
		return json(
			{ error: "workspaceId, path, content and deviceId are required" },
			{ status: 400 },
		);
	}

	const result = await workspaceStub(env, body.workspaceId).pushFile({
		path: body.path,
		contentHash: body.contentHash ?? "",
		content: body.content,
		deviceId: body.deviceId,
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
	if (!body?.workspaceId || !body.path || !body.deviceId) {
		return json(
			{ error: "workspaceId, path and deviceId are required" },
			{ status: 400 },
		);
	}
	const result = await workspaceStub(env, body.workspaceId).deleteFile({
		path: body.path,
		deviceId: body.deviceId,
	});
	return json({ ok: true, version: result.version });
}
