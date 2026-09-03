import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { assetsWalker, notesWalker } from "@mdly/workspace-scan";
import {
	contentHash,
	type FileSystem,
	type LocalAsset,
	type LocalFile,
} from "./fs.js";

export { WorkspaceTraversalLimitError } from "@mdly/workspace-scan";

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

export interface CreateNodeFileSystemOptions {
	/** Extra folder names (e.g. a workspace's Cloud Sync `excludedFolders`) the notes/assets walk never descends into, on top of the walkers' built-in defaults. */
	excludedFolders?: readonly string[];
	/** Caps how many entries the notes/assets walk visits before throwing `WorkspaceTraversalLimitError`, instead of walking an unbounded tree. */
	maxEntries?: number;
}

export function createNodeFileSystem(
	options?: CreateNodeFileSystemOptions,
): FileSystem {
	return {
		async readFile(path) {
			return readFileSync(path, "utf-8");
		},
		async writeFile(path, content) {
			writeFileSync(path, content);
		},
		async deleteFile(path) {
			unlinkSync(path);
		},
		async readFileOrNull(path) {
			return existsSync(path) ? readFileSync(path, "utf-8") : null;
		},
		async ensureDir(path) {
			mkdirSync(path, { recursive: true });
		},
		// Notes sync through the same ignore-rule-aware walker as the Mac
		// sidebar (packages/workspace-scan) — nested .gitignore/.ignore with
		// Git negation, pruning .mdly/.hubble — replacing the old blanket
		// "skip every dot-prefixed entry, honor no ignore file" rule (R12-R14).
		async listMarkdownFiles(dir) {
			const { files } = await notesWalker(dir, {
				excludedFolders: options?.excludedFolders,
				maxEntries: options?.maxEntries,
			});
			const results: LocalFile[] = [];
			for (const relativePath of files) {
				// The walk above and this read are two separate passes, so a file
				// (or its parent directory) deleted in between — a real race in a
				// workspace with concurrently-churning content, e.g. active git
				// worktrees — must not fail the whole sync run. Skipping it here
				// is safe: sync reconciles it as removed on the next cycle.
				let content: string;
				try {
					content = readFileSync(join(dir, relativePath), "utf-8");
				} catch (error) {
					if (isEnoent(error)) continue;
					throw error;
				}
				results.push({
					relativePath,
					content,
					hash: await contentHash(content),
				});
			}
			return results;
		},
		async readBinaryFile(path) {
			return new Uint8Array(readFileSync(path));
		},
		async writeBinaryFile(path, data) {
			writeFileSync(path, data);
		},
		// Same ignore rules as notes, except it still descends into
		// `*.assets` folders — the sidebar hides those, sync cannot (R13).
		// The 10MB cap is enforced inside assetsWalker itself.
		async listAssetFiles(dir) {
			const { files } = await assetsWalker(dir, {
				excludedFolders: options?.excludedFolders,
				maxEntries: options?.maxEntries,
			});
			const results: LocalAsset[] = [];
			for (const relativePath of files) {
				// Same walk-then-read race as listMarkdownFiles above — skip a file
				// deleted between the two passes rather than failing the sync run.
				let data: Buffer;
				try {
					data = readFileSync(join(dir, relativePath));
				} catch (error) {
					if (isEnoent(error)) continue;
					throw error;
				}
				results.push({
					relativePath,
					hash: await contentHash(new Uint8Array(data)),
				});
			}
			return results;
		},
	};
}
