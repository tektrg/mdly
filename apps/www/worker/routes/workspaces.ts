import { deleteWorkspace } from "../deleteWorkspace.js";
import type { Env } from "../env.js";
import { json, readJsonBody } from "../http.js";
import {
	ensureWorkspaceRegistered,
	listWorkspaceNames,
	registerWorkspace,
	WorkspaceAlreadyExistsError,
	workspaceExists,
} from "../workspaceRegistry.js";

/** GET /api/workspaces — every workspace the shared password grants access to (R33, R38). */
export async function handleListWorkspaces(
	_request: Request,
	env: Env,
): Promise<Response> {
	const names = await listWorkspaceNames(env);
	return json({
		workspaces: names.map((name) => ({ workspaceId: name, name })),
	});
}

/** GET /api/workspace?name=... — SyncBackend.getWorkspace. */
export async function handleGetWorkspace(
	request: Request,
	env: Env,
): Promise<Response> {
	const name = new URL(request.url).searchParams.get("name");
	if (!name) return json({ error: "name is required" }, { status: 400 });
	const exists = await workspaceExists(env, name);
	return json({ workspaceId: exists ? name : null });
}

/** POST /api/workspace {name} — SyncBackend.createWorkspace. */
export async function handleCreateWorkspace(
	request: Request,
	env: Env,
): Promise<Response> {
	const body = await readJsonBody<{ name?: string }>(request);
	if (!body?.name) return json({ error: "name is required" }, { status: 400 });
	try {
		await registerWorkspace(env, body.name);
	} catch (error) {
		if (error instanceof WorkspaceAlreadyExistsError) {
			return json({ error: error.message }, { status: 409 });
		}
		throw error;
	}
	return json({ workspaceId: body.name });
}

/**
 * POST /api/workspace/enable {name} — the "opt-in toggle" server-side half
 * (R28): idempotently registers the workspace so it becomes listable, even
 * if it wasn't explicitly `createWorkspace`d first. Flipping local desktop
 * config alone must never be sufficient — this is the call that makes it
 * sufficient.
 */
export async function handleEnableWorkspace(
	request: Request,
	env: Env,
): Promise<Response> {
	const body = await readJsonBody<{ name?: string }>(request);
	if (!body?.name) return json({ error: "name is required" }, { status: 400 });
	await ensureWorkspaceRegistered(env, body.name);
	return json({ workspaceId: body.name });
}

/**
 * POST /api/workspace/delete {name} — the "opt-in toggle" OFF path's server
 * side (R36): deletes the workspace's DO-backed files/assets/versions and any
 * R2 objects no longer referenced by any other opted-in workspace (see
 * deleteWorkspace.ts for the reference-aware ordering), and removes it from
 * the registry so `handleListWorkspaces` stops returning it. Idempotent — a
 * repeat call for an already-deleted workspace succeeds quietly.
 */
export async function handleDeleteWorkspace(
	request: Request,
	env: Env,
): Promise<Response> {
	const body = await readJsonBody<{ name?: string }>(request);
	if (!body?.name) return json({ error: "name is required" }, { status: 400 });
	await deleteWorkspace(env, body.name);
	return json({ ok: true });
}
