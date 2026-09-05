import type { Env } from "./env.js";
import { assetR2Key } from "./routes/assets.js";
import { workspaceStub } from "./routes/workspaceStub.js";

/**
 * The cross-workspace R2 refcount check (R5's invariant), factored out so
 * BOTH the nightly orphan-asset cron (cron.ts) and workspace deletion
 * (deleteWorkspace.ts) share exactly ONE implementation of "is this hash
 * still needed anywhere" — R2 objects are content-addressed
 * (`assets/<sha256>`), so the same hash can be referenced by more than one
 * workspace's `assets`/`versions` rows. Deleting a hash without this check
 * would silently destroy an image another opted-in workspace still uses.
 */

/** Every hash still referenced by ANY workspace named in `workspaceNames`. */
export async function computeGloballyReferencedHashes(
	env: Env,
	workspaceNames: string[],
): Promise<Set<string>> {
	const hashes = new Set<string>();
	for (const name of workspaceNames) {
		const stub = workspaceStub(env, name);
		for (const hash of await stub.referencedHashes()) hashes.add(hash);
	}
	return hashes;
}

/**
 * Deletes each of `candidateHashes` from R2 UNLESS it appears in
 * `globallyReferencedHashes`. This is the ONLY place an R2 asset object is
 * actually removed — both the cron GC and workspace deletion call this
 * instead of touching `env.ASSET_BUCKET.delete` directly.
 */
export async function deleteR2ObjectsIfUnreferenced(
	env: Env,
	candidateHashes: Iterable<string>,
	globallyReferencedHashes: Set<string>,
): Promise<number> {
	let deleted = 0;
	for (const hash of candidateHashes) {
		if (globallyReferencedHashes.has(hash)) continue;
		await env.ASSET_BUCKET.delete(assetR2Key(hash));
		deleted++;
	}
	return deleted;
}
