import fs from "node:fs/promises";
import path from "node:path";
import { discoverWorkspaceFiles } from "../file-discovery.js";
import { toWorkspaceRelativePath } from "./shared.js";
import type { WalkerResult } from "./types.js";

const IMAGE_EXTENSION_RE = /\.(png|jpe?g|gif|bmp|svg|webp)$/i;

/** Matches `packages/sync/src/fs-node.ts`'s pre-existing `MAX_ASSET_SIZE`. */
export const MAX_ASSET_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * The cloud-sync "assets" walker (R13): images up to 10MB, under the same
 * ignore rules as the notes walker, EXCEPT it must still traverse `*.assets`
 * folders — the sidebar hides them, but that is exactly where images live,
 * so sync cannot hide them too. `.hubble` and `.mdly` stay pruned.
 */
export interface AssetsWalkerOptions {
	/** Exclusion entries (bare names at any depth, or workspace-anchored paths) pruned on top of the built-in `.hubble`/`.mdly` rules. */
	excludedFolders?: readonly string[];
	/** Forwarded to `discoverWorkspaceFiles` — throws `WorkspaceTraversalLimitError` past this many visited entries instead of walking an unbounded tree. */
	maxEntries?: number;
	/** Forwarded to `discoverWorkspaceFiles` — throws `WorkspaceDirectoryLimitError` past this many visited directories. */
	maxDirectories?: number;
	/** Live walk counts for indeterminate progress. */
	onVisit?: (visited: {
		visitedEntryCount: number;
		visitedDirectoryCount: number;
	}) => void;
}

export async function assetsWalker(
	workspaceRoot: string,
	options?: AssetsWalkerOptions,
): Promise<WalkerResult> {
	const root = path.resolve(workspaceRoot);
	const discovery = await discoverWorkspaceFiles({
		workspaceRoot: root,
		isSupportedFile: (candidatePath) => IMAGE_EXTENSION_RE.test(candidatePath),
		isVisibleFolderName: (name) => name !== ".hubble" && name !== ".mdly",
		alwaysIgnoredDirectoryNames: options?.excludedFolders,
		maxEntries: options?.maxEntries,
		maxDirectories: options?.maxDirectories,
		pruneNestedRepos: true,
		onVisit: options?.onVisit,
	});

	const files: string[] = [];
	const errors = [...discovery.errors];
	const details: Record<string, { size: number; modifiedAt: number }> = {};
	for (const entry of discovery.files) {
		// Prefer the size the walk already recorded; stat only when the
		// entry predates it (one syscall either way, never two).
		let size = entry.size;
		if (size === undefined) {
			try {
				size = Number((await fs.stat(entry.path)).size);
			} catch (error) {
				errors.push({
					path: entry.path,
					message: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
		}
		if (size > MAX_ASSET_SIZE) continue;
		const rel = toWorkspaceRelativePath(entry.path, root);
		files.push(rel);
		details[rel] = { size, modifiedAt: entry.modified_at };
	}

	return {
		files: files.sort(),
		errors,
		stats: {
			visitedEntryCount: discovery.stats.visitedEntryCount,
			visitedDirectoryCount: discovery.stats.visitedDirectoryCount,
		},
		details,
	};
}
