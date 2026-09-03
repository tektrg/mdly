import type { WorkspaceDurableObject } from "../durableObject/workspaceDurableObject.js";
import type { Env } from "../env.js";

/**
 * Resolves the one Durable Object instance for a workspace name. `name` IS
 * the `workspaceId` everywhere in this Worker (see workspaceRegistry.ts) —
 * `idFromName` is exactly the deterministic per-workspace identity the
 * charter's data model relies on instead of a separate `workspaces` table.
 */
export function workspaceStub(
	env: Env,
	workspaceId: string,
): DurableObjectStub<WorkspaceDurableObject> {
	const id = env.WORKSPACE_DO.idFromName(workspaceId);
	return env.WORKSPACE_DO.get(id);
}
