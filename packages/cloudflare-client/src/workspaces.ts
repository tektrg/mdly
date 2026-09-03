import { authFetchInit, authHeaders, type CloudflareAuth } from "./auth.js";
import { CloudflareResponseError } from "./errors.js";
import { buildUrl, jsonRequestInit, requestJson } from "./httpClient.js";
import {
	DeleteWorkspaceResponseSchema,
	ListWorkspacesResponseSchema,
} from "./schemas.js";

export type WorkspaceSummary = { workspaceId: string; name: string };

/**
 * GET /api/workspaces — every workspace the shared password grants access to
 * (R32, R33, D8c). Not one of `SyncBackend`'s 10 methods (there is no
 * per-workspace scoping — it's the whole-account list), so it's exported
 * separately for `apps/www`'s workspace switcher to call directly.
 */
export async function listWorkspaces(options: {
	baseUrl: string;
	auth: CloudflareAuth;
}): Promise<WorkspaceSummary[]> {
	const data = await requestJson(
		buildUrl(options.baseUrl, "/api/workspaces"),
		{ headers: authHeaders(options.auth), ...authFetchInit(options.auth) },
		ListWorkspacesResponseSchema,
		"listWorkspaces",
	);
	return data.workspaces;
}

/**
 * POST /api/login {password} — the one legitimately-unauthenticated route
 * (R41). Returns whether login succeeded; a wrong password resolves `false`
 * with no thrown error and no way to distinguish it from an absent one, by
 * design (the Worker itself never leaks that distinction — see
 * apps/www/worker/auth.ts).
 */
export async function loginWithPassword(
	baseUrl: string,
	password: string,
): Promise<boolean> {
	const response = await fetch(buildUrl(baseUrl, "/api/login"), {
		method: "POST",
		credentials: "same-origin",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ password }),
	});
	return response.ok;
}

export type DeleteWorkspaceOptions = {
	baseUrl: string;
	auth: CloudflareAuth;
	workspaceId: string;
};

/**
 * POST /api/workspace/delete {name} — deletes a workspace's entire
 * Cloudflare copy: its DO-backed files/assets/versions, any R2 objects no
 * longer referenced by another opted-in workspace, and its entry in the
 * registry the list-workspaces route reads (R36 — closes the charter gap
 * where turning cloud sync off only stopped local pushes and never told the
 * backend anything). Not one of `SyncBackend`'s 10 methods — same reasoning
 * as `listWorkspaces` above — so `apps/desktop`'s `disableCloudSyncForWorkspace`
 * calls this directly rather than through the backend it gets from
 * `createCloudflareBackend`.
 */
export async function deleteWorkspace(
	options: DeleteWorkspaceOptions,
): Promise<void> {
	await requestJson(
		buildUrl(options.baseUrl, "/api/workspace/delete"),
		{
			...jsonRequestInit(
				{ name: options.workspaceId },
				authHeaders(options.auth),
			),
			...authFetchInit(options.auth),
		},
		DeleteWorkspaceResponseSchema,
		"deleteWorkspace",
	);
}

export async function logout(baseUrl: string): Promise<void> {
	const response = await fetch(buildUrl(baseUrl, "/api/logout"), {
		method: "POST",
		credentials: "same-origin",
	});
	if (!response.ok) {
		throw new CloudflareResponseError("logout failed", response.status);
	}
}
