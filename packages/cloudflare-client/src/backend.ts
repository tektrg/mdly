import type { AuthorizedUrl, SyncBackend } from "@hubble.md/sync";
import { authFetchInit, authHeaders, type CloudflareAuth } from "./auth.js";
import { buildUrl, jsonRequestInit, requestJson } from "./httpClient.js";
import {
	CreateWorkspaceResponseSchema,
	DownloadUrlResponseSchema,
	GetAssetsResponseSchema,
	GetFilesResponseSchema,
	MutationOkResponseSchema,
	UploadUrlResponseSchema,
	WorkspaceIdResponseSchema,
} from "./schemas.js";

export type CreateCloudflareBackendOptions = {
	/** Absolute origin of the deployed (or locally running) Worker, e.g. "https://garden.theindie.app" or "http://127.0.0.1:8787". Never inferred — the caller (apps/www, the CLI) decides this once. */
	baseUrl: string;
	auth: CloudflareAuth;
};

/**
 * Implements every `SyncBackend` method (R1, R9) as one HTTP call each
 * against the real Worker, with every response validated by zod
 * (`requestJson`) before it's trusted. Matches the Worker's wire format
 * exactly (apps/www/worker/routes/*.ts) — this package is the client that
 * conforms to that already-shipped contract, not the other way around.
 */
export function createCloudflareBackend(
	options: CreateCloudflareBackendOptions,
): SyncBackend {
	const { baseUrl, auth } = options;
	const headers = () => authHeaders(auth);
	const init = () => authFetchInit(auth);

	return {
		async getWorkspace(name) {
			const data = await requestJson(
				buildUrl(baseUrl, "/api/workspace", { name }),
				{ headers: headers(), ...init() },
				WorkspaceIdResponseSchema,
				"getWorkspace",
			);
			return data.workspaceId;
		},

		async createWorkspace(name) {
			const data = await requestJson(
				buildUrl(baseUrl, "/api/workspace"),
				{ ...jsonRequestInit({ name }, headers()), ...init() },
				CreateWorkspaceResponseSchema,
				"createWorkspace",
			);
			return data.workspaceId;
		},

		async getFiles(workspaceId, opts) {
			const data = await requestJson(
				buildUrl(baseUrl, "/api/files", {
					workspaceId,
					since: opts?.since?.toString(),
					includeDeleted: opts?.includeDeleted ? "true" : undefined,
				}),
				{ headers: headers(), ...init() },
				GetFilesResponseSchema,
				"getFiles",
			);
			return data.files;
		},

		async pushFile(args) {
			await requestJson(
				buildUrl(baseUrl, "/api/files"),
				{ ...jsonRequestInit(args, headers()), ...init() },
				MutationOkResponseSchema,
				"pushFile",
			);
		},

		async softDeleteFile(args) {
			await requestJson(
				buildUrl(baseUrl, "/api/files/delete"),
				{ ...jsonRequestInit(args, headers()), ...init() },
				MutationOkResponseSchema,
				"softDeleteFile",
			);
		},

		async getAssets(workspaceId, since) {
			const data = await requestJson(
				buildUrl(baseUrl, "/api/assets", {
					workspaceId,
					since: since?.toString(),
				}),
				{ headers: headers(), ...init() },
				GetAssetsResponseSchema,
				"getAssets",
			);
			return data.assets;
		},

		async pushAsset(args) {
			await requestJson(
				buildUrl(baseUrl, "/api/assets"),
				{ ...jsonRequestInit(args, headers()), ...init() },
				MutationOkResponseSchema,
				"pushAsset",
			);
		},

		async softDeleteAsset(args) {
			await requestJson(
				buildUrl(baseUrl, "/api/assets/delete"),
				{ ...jsonRequestInit(args, headers()), ...init() },
				MutationOkResponseSchema,
				"softDeleteAsset",
			);
		},

		// --- Asset upload/download URLs (the fix for the unauthenticated-fetch
		// defect, see packages/sync/src/sync.ts): every URL is returned
		// alongside the headers the caller must attach to actually reach it.
		// Bearer callers (CLI/desktop) get the Authorization header back so
		// their bare `fetch(url, {headers})` is authenticated. Cookie callers
		// (the browser) get no extra headers — a same-origin `fetch`/`<img>`
		// already carries the session cookie automatically, and a browser
		// can't attach a custom header to an `<img src>` request anyway.
		async generateAssetUploadUrl(): Promise<AuthorizedUrl> {
			const data = await requestJson(
				buildUrl(baseUrl, "/api/asset/upload-url"),
				{ headers: headers(), ...init() },
				UploadUrlResponseSchema,
				"generateAssetUploadUrl",
			);
			return { url: data.uploadUrl, headers: headers() };
		},

		async getAssetDownloadUrl(storageId): Promise<AuthorizedUrl | null> {
			const data = await requestJson(
				buildUrl(baseUrl, "/api/asset/download-url", { storageId }),
				{ headers: headers(), ...init() },
				DownloadUrlResponseSchema,
				"getAssetDownloadUrl",
			);
			if (!data.url) return null;
			return { url: data.url, headers: headers() };
		},
	};
}
