import {
	computeGloballyReferencedHashes,
	deleteR2ObjectsIfUnreferenced,
} from "./assetGc.js";
import type { Env } from "./env.js";
import { workspaceStub } from "./routes/workspaceStub.js";
import {
	listWorkspaceNames,
	removeWorkspaceName,
} from "./workspaceRegistry.js";

/**
 * Closes the charter's R36 gap: turning cloud sync OFF for a workspace must
 * delete that workspace's copy from Cloudflare (notes + images) and remove
 * it from the site's workspace list — not just stop pushing to it. "Off"
 * means gone; re-enabling later re-uploads from scratch (accepted per the
 * user's 2026-09-01 decision).
 *
 * Order matters, and is deliberately THIS order:
 *  1. Read the workspace's own referenced hashes BEFORE wiping anything —
 *     once `deleteAllData()` runs, this workspace can no longer answer that
 *     question (its rows are gone).
 *  2. Remove the workspace from the registry FIRST, before wiping DO
 *     storage — even if the DO wipe or R2 cleanup below throws partway, the
 *     workspace must not remain listed (R33/R36 outrank R5's cleanup timing;
 *     a visible-but-empty workspace is worse than a hidden one that still
 *     has stray rows for a moment).
 *  3. Wipe the DO's own storage (files/assets/versions/devices/meta).
 *  4. Reference-aware R2 cleanup, reusing the SAME cross-workspace refcount
 *     helper the nightly cron GC uses (the trap: R2 objects are
 *     content-addressed and can be shared across workspaces) — computed
 *     against the registry with this workspace already removed, so a hash
 *     still used by another opted-in workspace is never touched.
 *
 * Idempotent by construction: calling this again on an already-deleted
 * workspace finds no referenced hashes (step 1 returns empty), no registry
 * entry to remove (step 2 no-ops), an already-empty DO to wipe (step 3
 * no-ops), and nothing left to reconsider for R2 (step 4 deletes nothing) —
 * it succeeds quietly rather than erroring.
 */
export async function deleteWorkspace(
	env: Env,
	workspaceId: string,
): Promise<{ r2ObjectsDeleted: number }> {
	const stub = workspaceStub(env, workspaceId);

	const candidateHashes = await stub.referencedHashes();

	await removeWorkspaceName(env, workspaceId);

	await stub.deleteAllData();

	const remainingNames = await listWorkspaceNames(env);
	const globallyReferencedHashes = await computeGloballyReferencedHashes(
		env,
		remainingNames,
	);
	const r2ObjectsDeleted = await deleteR2ObjectsIfUnreferenced(
		env,
		candidateHashes,
		globallyReferencedHashes,
	);

	return { r2ObjectsDeleted };
}
