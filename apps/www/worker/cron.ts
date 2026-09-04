import {
	computeGloballyReferencedHashes,
	deleteR2ObjectsIfUnreferenced,
} from "./assetGc.js";
import type {
	AssetCursor,
	AssetPage,
	GcAssetCursor,
	GcAssetPage,
	RemoteAssetLike,
} from "./durableObject/assets.js";
import type {
	FileCursor,
	FilePage,
	RemoteFileLike,
} from "./durableObject/files.js";
import type { WorkspaceDurableObject } from "./durableObject/workspaceDurableObject.js";
import type { Env } from "./env.js";
import { orphanAssetCandidates, referencedAssetPaths } from "./orphanAssets.js";
import { workspaceStub } from "./routes/workspaceStub.js";
import { listWorkspaceNames } from "./workspaceRegistry.js";

const ORPHAN_ASSET_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const ASSET_CLEANUP_DEVICE_ID = "asset-orphan-cleanup";

/**
 * Full-workspace reads through the byte-bounded listing pages. The GC needs
 * the whole workspace view, but no single RPC call may approach the ceiling —
 * so page locally and concatenate. Cursors strictly advance per page, so the
 * loops terminate.
 */
async function listAllFiles(
	stub: DurableObjectStub<WorkspaceDurableObject>,
	opts: { includeDeleted: boolean },
): Promise<RemoteFileLike[]> {
	const all: RemoteFileLike[] = [];
	let cursor: FileCursor | null = null;
	do {
		const page: FilePage = await stub.listFiles({ ...opts, cursor });
		all.push(...page.files);
		cursor = page.nextCursor;
	} while (cursor);
	return all;
}

async function listAllAssets(
	stub: DurableObjectStub<WorkspaceDurableObject>,
	since?: number,
): Promise<RemoteAssetLike[]> {
	const all: RemoteAssetLike[] = [];
	let cursor: AssetCursor | null = null;
	do {
		const page: AssetPage = await stub.listAssets({ since, cursor });
		all.push(...page.assets);
		cursor = page.nextCursor;
	} while (cursor);
	return all;
}

async function listAllAssetsForGc(
	stub: DurableObjectStub<WorkspaceDurableObject>,
): Promise<{ path: string; deleted: boolean; orphanedAt?: number }[]> {
	const all: { path: string; deleted: boolean; orphanedAt?: number }[] = [];
	let cursor: GcAssetCursor | null = null;
	do {
		const page: GcAssetPage = await stub.listAssetsForGc({ cursor });
		all.push(...page.assets);
		cursor = page.nextCursor;
	} while (cursor);
	return all;
}

/**
 * Nightly Cron Trigger (R5). Mirrors the old Convex
 * `runOrphanAssetCleanupForAllWorkspaces`'s two-phase mark-then-delete shape,
 * but adds a cross-workspace refcount step: because R2 assets are
 * content-addressed (`assets/<sha256>`, shared across paths AND across
 * workspaces), a hash is only actually removed from R2 once no `assets` row
 * in ANY workspace still references it — never inline on a push, only here.
 */
export async function runOrphanAssetCleanup(env: Env): Promise<{
	workspaces: number;
	marked: number;
	restored: number;
	rowsDeleted: number;
	r2ObjectsDeleted: number;
}> {
	const names = await listWorkspaceNames(env);
	let marked = 0;
	let restored = 0;
	let rowsDeleted = 0;
	const deletedHashesByWorkspace: string[][] = [];

	// Phase 1: mark/restore candidates in every workspace using the SAME
	// ported-verbatim function the old Convex backend used.
	for (const name of names) {
		const stub = workspaceStub(env, name);
		const files = await listAllFiles(stub, { includeDeleted: true });
		const assets = await listAllAssetsForGc(stub);
		const references = referencedAssetPaths(files, assets);
		const now = Date.now();

		for (const asset of assets) {
			if (asset.deleted) continue;
			if (references.has(asset.path)) {
				if (asset.orphanedAt !== undefined) {
					await stub.clearOrphaned(asset.path);
					restored++;
				}
				continue;
			}
			if (asset.orphanedAt === undefined) {
				await stub.markOrphaned(asset.path, now);
				marked++;
			}
		}
	}

	// Phase 2: rescan each workspace and soft-delete rows past the grace
	// period that are STILL unreferenced, recording which hash each deleted
	// row pointed at (so phase 3 can refcount across workspaces).
	for (const name of names) {
		const stub = workspaceStub(env, name);
		const files = await listAllFiles(stub, { includeDeleted: true });
		const assetsForGc = await listAllAssetsForGc(stub);
		const assetRows = await listAllAssets(stub);
		const cutoff = Date.now() - ORPHAN_ASSET_GRACE_PERIOD_MS;

		const candidates = orphanAssetCandidates(files, assetsForGc);
		const candidatePaths = new Set(candidates.map((c) => c.path));
		const hashesDeletedHere: string[] = [];

		for (const asset of assetsForGc) {
			if (!candidatePaths.has(asset.path)) continue;
			if (asset.orphanedAt === undefined || asset.orphanedAt > cutoff) continue;

			const row = assetRows.find((a) => a.path === asset.path);
			if (!row) continue;

			await stub.markDeletedByGc(asset.path, ASSET_CLEANUP_DEVICE_ID);
			rowsDeleted++;
			hashesDeletedHere.push(row.contentHash);
		}
		deletedHashesByWorkspace.push(hashesDeletedHere);
	}

	// Phase 3: cross-workspace refcount. Only delete an R2 object once NO
	// workspace's assets/versions rows reference the hash anymore. Shared with
	// workspace deletion (deleteWorkspace.ts) via assetGc.ts — one
	// implementation of the reference-aware invariant, not two.
	const globallyReferencedHashes = await computeGloballyReferencedHashes(
		env,
		names,
	);
	const consideredHashes = new Set(deletedHashesByWorkspace.flat());
	const r2ObjectsDeleted = await deleteR2ObjectsIfUnreferenced(
		env,
		consideredHashes,
		globallyReferencedHashes,
	);

	return {
		workspaces: names.length,
		marked,
		restored,
		rowsDeleted,
		r2ObjectsDeleted,
	};
}
