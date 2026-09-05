import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { assetsWalker, notesWalker, sidecarWalker } from "@mdly/workspace-scan";
import {
	contentHash,
	type FileSystem,
	type LocalAsset,
	type LocalFile,
} from "./fs.js";
import { isSyncedSidecarPath } from "./sidecarScope.js";

export {
	WorkspaceDirectoryLimitError,
	WorkspaceTraversalLimitError,
} from "@mdly/workspace-scan";

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

export interface CreateNodeFileSystemOptions {
	/** Exclusion entries (names at any depth, or workspace-anchored paths) the notes/assets walk never descends into, on top of the walkers' built-in defaults. */
	excludedFolders?: readonly string[];
	/** Caps how many entries the notes/assets walk visits before throwing `WorkspaceTraversalLimitError`, instead of walking an unbounded tree. */
	maxEntries?: number;
	/** Caps how many directories the walk visits before throwing `WorkspaceDirectoryLimitError` — directories are what consume OS watch handles, so this is the watcher's actual constraint. */
	maxDirectories?: number;
	/**
	 * Live walk counts for indeterminate progress UI ("scanned N entries…",
	 * no total until the walk ends). Called at most every 50 visited
	 * entries per walker — throttled upstream, never per file.
	 */
	onScan?: (visited: {
		visitedEntryCount: number;
		visitedDirectoryCount: number;
	}) => void;
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
			const { files, details } = await notesWalker(dir, {
				excludedFolders: options?.excludedFolders,
				maxEntries: options?.maxEntries,
				maxDirectories: options?.maxDirectories,
				onVisit: options?.onScan,
			});
			const results: LocalFile[] = [];
			for (const relativePath of files) {
				// The walk above and this read are two separate passes, so a file
				// (or its parent directory) deleted in between — a real race in a
				// workspace with concurrently-churning content, e.g. active git
				// worktrees — must not fail the whole sync run. Skipping it here
				// is safe: sync reconciles it as removed on the next cycle.
				let content: string;
				// Prefer the stat snapshot the walk already took (one syscall
				// total, not two); fall back to a direct stat only when the
				// walker predates it (e.g. mocked in tests). mtime is seconds
				// here (walker's clock), not ms — consistent within a version.
				let mtime = details?.[relativePath]?.modifiedAt;
				let size = details?.[relativePath]?.size;
				try {
					const absolute = join(dir, relativePath);
					content = readFileSync(absolute, "utf-8");
					if (mtime === undefined || size === undefined) {
						try {
							const st = statSync(absolute);
							mtime = Math.floor(st.mtimeMs / 1000);
							size = st.size;
						} catch {
							// Stat is a hint only — a file that vanishes here is
							// still skipped via the ENOENT path on read.
						}
					}
				} catch (error) {
					if (isEnoent(error)) continue;
					throw error;
				}
				results.push({
					relativePath,
					content,
					hash: await contentHash(content),
					mtime,
					size,
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
		// Sidecars deliberately ignore options.excludedFolders: the desktop
		// default list contains `.mdly`, so forwarding it would silently
		// return nothing forever. The walker's own hard exclusion of
		// `.mdly/history/objects/**` plus the isSyncedSidecarPath allowlist
		// are the only filters. Same ENOENT-skip read loop as
		// listMarkdownFiles above. Wired into plan() (Round 3) and
		// execute() (Round 4).
		async listSidecarFiles(dir) {
			const { files, details } = await sidecarWalker(dir, {
				include: isSyncedSidecarPath,
			});
			const results: LocalFile[] = [];
			for (const relativePath of files) {
				let content: string;
				let mtime = details?.[relativePath]?.modifiedAt;
				let size = details?.[relativePath]?.size;
				try {
					const absolute = join(dir, relativePath);
					content = readFileSync(absolute, "utf-8");
					if (mtime === undefined || size === undefined) {
						try {
							const st = statSync(absolute);
							mtime = Math.floor(st.mtimeMs / 1000);
							size = st.size;
						} catch {
							// Stat is a hint only — same as above.
						}
					}
				} catch (error) {
					if (isEnoent(error)) continue;
					throw error;
				}
				results.push({
					relativePath,
					content,
					hash: await contentHash(content),
					mtime,
					size,
				});
			}
			return results;
		},
		// Same ignore rules as notes, except it still descends into
		// `*.assets` folders — the sidebar hides those, sync cannot (R13).
		// The 10MB cap is enforced inside assetsWalker itself.
		async listAssetFiles(dir) {
			const { files, details } = await assetsWalker(dir, {
				excludedFolders: options?.excludedFolders,
				maxEntries: options?.maxEntries,
				maxDirectories: options?.maxDirectories,
				onVisit: options?.onScan,
			});
			const results: LocalAsset[] = [];
			for (const relativePath of files) {
				// Same walk-then-read race as listMarkdownFiles above — skip a file
				// deleted between the two passes rather than failing the sync run.
				let data: Buffer;
				let mtime = details?.[relativePath]?.modifiedAt;
				let size = details?.[relativePath]?.size;
				try {
					const absolute = join(dir, relativePath);
					data = readFileSync(absolute);
					if (mtime === undefined || size === undefined) {
						try {
							const st = statSync(absolute);
							mtime = Math.floor(st.mtimeMs / 1000);
							size = st.size;
						} catch {
							// Hint only — ignore.
						}
					}
				} catch (error) {
					if (isEnoent(error)) continue;
					throw error;
				}
				results.push({
					relativePath,
					hash: await contentHash(new Uint8Array(data)),
					mtime,
					size,
				});
			}
			return results;
		},
	};
}
