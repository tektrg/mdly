import type { Env } from "./env.js";

/**
 * Server-side workspace registry (R28, R33, R38).
 *
 * The DO's own SQLite schema deliberately has no `workspaces` table (a
 * per-workspace DO's identity is fully determined by
 * `WORKSPACE_DO.idFromName(name)` — see the charter's "two implementation
 * choices folded in without further debate"). But *something* still has to
 * answer "which workspace names has the Mac ever opted in / created", for
 * the authenticated list-workspaces route (R33) and so flipping a
 * workspace's toggle on actually makes it discoverable server-side (R28) —
 * flipping local config alone must not be enough. A single KV JSON blob is
 * that registry: cheap, already-provisioned (the same SESSIONS namespace
 * this Worker already binds), and proportionate to "a handful of personal
 * workspaces," not a scale that needs its own index structure.
 *
 * `workspaceId` in every SyncBackend method is simply the workspace name —
 * it is already a stable, human-chosen string, and `idFromName` needs
 * exactly that. Introducing a second opaque id would only add a translation
 * layer with nothing to translate.
 */

const REGISTRY_KEY = "workspace-registry";

async function readRegistry(env: Env): Promise<string[]> {
	const raw = await env.SESSIONS.get(REGISTRY_KEY);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((v) => typeof v === "string")
			: [];
	} catch {
		return [];
	}
}

async function writeRegistry(env: Env, names: string[]): Promise<void> {
	await env.SESSIONS.put(REGISTRY_KEY, JSON.stringify(names));
}

export async function listWorkspaceNames(env: Env): Promise<string[]> {
	return readRegistry(env);
}

export async function workspaceExists(
	env: Env,
	name: string,
): Promise<boolean> {
	return (await readRegistry(env)).includes(name);
}

export class WorkspaceAlreadyExistsError extends Error {
	constructor(name: string) {
		super(`Workspace "${name}" already exists`);
		this.name = "WorkspaceAlreadyExistsError";
	}
}

/** Registers a workspace name. Throws if it already exists (matches the Convex-era contract). */
export async function registerWorkspace(env: Env, name: string): Promise<void> {
	const names = await readRegistry(env);
	if (names.includes(name)) throw new WorkspaceAlreadyExistsError(name);
	await writeRegistry(env, [...names, name]);
}

/** Idempotently ensures a workspace is registered — used by the "opt-in toggle" path (R28), which is not an error if already registered. */
export async function ensureWorkspaceRegistered(
	env: Env,
	name: string,
): Promise<void> {
	const names = await readRegistry(env);
	if (names.includes(name)) return;
	await writeRegistry(env, [...names, name]);
}

/**
 * Idempotently removes a workspace name from the registry (R36's server-side
 * half: "off" must make the workspace stop being listable, not just stop
 * receiving pushes). Removing a name that was never registered — e.g. a
 * repeat delete call — is a quiet no-op, not an error.
 */
export async function removeWorkspaceName(
	env: Env,
	name: string,
): Promise<void> {
	const names = await readRegistry(env);
	if (!names.includes(name)) return;
	await writeRegistry(
		env,
		names.filter((n) => n !== name),
	);
}
