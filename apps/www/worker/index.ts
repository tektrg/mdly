import { handleLogin, handleLogout, withAuth } from "./auth.js";
import { runOrphanAssetCleanup } from "./cron.js";
import type { Env } from "./env.js";
import { json } from "./http.js";
import {
	handleAssetDownload,
	handleAssetUpload,
	handleGenerateAssetUploadUrl,
	handleGetAssetDownloadUrl,
	handleGetAssets,
	handlePushAsset,
	handleSoftDeleteAsset,
} from "./routes/assets.js";
import { handleRegisterDevice } from "./routes/devices.js";
import {
	handleGetFiles,
	handlePushFile,
	handleSoftDeleteFile,
} from "./routes/files.js";
import { workspaceStub } from "./routes/workspaceStub.js";
import {
	handleCreateWorkspace,
	handleDeleteWorkspace,
	handleEnableWorkspace,
	handleGetWorkspace,
	handleListWorkspaces,
} from "./routes/workspaces.js";

export { WorkspaceDurableObject } from "./durableObject/workspaceDurableObject.js";

function errorResponse(error: unknown): Response {
	const message = error instanceof Error ? error.message : String(error);
	return json({ error: message }, { status: 500 });
}

const ASSET_DOWNLOAD_PATTERN = /^\/api\/asset\/([^/]+)$/;
const WORKSPACE_SOCKET_PATTERN = /^\/api\/workspace\/([^/]+)\/socket$/;

async function handleApi(
	request: Request,
	env: Env,
	url: URL,
): Promise<Response> {
	const { pathname: path } = url;
	const method = request.method;

	// Public — must stay outside withAuth (R41: a wrong password sets no
	// cookie and looks exactly like an absent one; login is the one route
	// that legitimately answers without already holding a credential).
	if (path === "/api/login" && method === "POST")
		return handleLogin(request, env);
	if (path === "/api/logout" && method === "POST")
		return handleLogout(request, env);

	// Every other /api/* route, including the WebSocket upgrade, is gated
	// (R40) — nothing below this line is reachable without a valid cookie or
	// bearer token.
	const socketMatch = WORKSPACE_SOCKET_PATTERN.exec(path);
	if (socketMatch) {
		const workspaceId = decodeURIComponent(socketMatch[1] ?? "");
		return withAuth(request, env, async () =>
			workspaceStub(env, workspaceId).fetch(request),
		);
	}

	if (path === "/api/workspaces" && method === "GET") {
		return withAuth(request, env, () => handleListWorkspaces(request, env));
	}
	if (path === "/api/workspace" && method === "GET") {
		return withAuth(request, env, () => handleGetWorkspace(request, env));
	}
	if (path === "/api/workspace" && method === "POST") {
		return withAuth(request, env, () => handleCreateWorkspace(request, env));
	}
	if (path === "/api/workspace/enable" && method === "POST") {
		return withAuth(request, env, () => handleEnableWorkspace(request, env));
	}
	if (path === "/api/workspace/delete" && method === "POST") {
		return withAuth(request, env, () => handleDeleteWorkspace(request, env));
	}

	if (path === "/api/files" && method === "GET") {
		return withAuth(request, env, () => handleGetFiles(request, env));
	}
	if (path === "/api/files" && method === "POST") {
		return withAuth(request, env, () => handlePushFile(request, env));
	}
	if (path === "/api/files/delete" && method === "POST") {
		return withAuth(request, env, () => handleSoftDeleteFile(request, env));
	}

	if (path === "/api/assets" && method === "GET") {
		return withAuth(request, env, () => handleGetAssets(request, env));
	}
	if (path === "/api/assets" && method === "POST") {
		return withAuth(request, env, () => handlePushAsset(request, env));
	}
	if (path === "/api/assets/delete" && method === "POST") {
		return withAuth(request, env, () => handleSoftDeleteAsset(request, env));
	}

	if (path === "/api/asset/upload-url" && method === "GET") {
		return withAuth(request, env, async () =>
			handleGenerateAssetUploadUrl(request),
		);
	}
	if (path === "/api/asset/download-url" && method === "GET") {
		return withAuth(request, env, async () =>
			handleGetAssetDownloadUrl(request, url.searchParams.get("storageId")),
		);
	}
	if (path === "/api/asset/upload" && method === "POST") {
		return withAuth(request, env, () => handleAssetUpload(request, env));
	}
	const assetMatch = ASSET_DOWNLOAD_PATTERN.exec(path);
	if (assetMatch && method === "GET") {
		const hash = decodeURIComponent(assetMatch[1] ?? "");
		return withAuth(request, env, () => handleAssetDownload(hash, env));
	}

	if (path === "/api/device/register" && method === "POST") {
		return withAuth(request, env, () => handleRegisterDevice(request, env));
	}

	return json({ error: "Not found" }, { status: 404 });
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (url.pathname.startsWith("/api/")) {
				return await handleApi(request, env, url);
			}
		} catch (error) {
			return errorResponse(error);
		}
		// Not an API route — serve the SPA assets (SPA deep-link fallback is
		// configured in wrangler.toml's [assets] block, mirroring
		// apps/notion-web).
		return env.ASSETS.fetch(request);
	},

	async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
		await runOrphanAssetCleanup(env);
	},
} satisfies ExportedHandler<Env>;
