import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { assetsWalker, notesWalker, sidecarWalker } from "@mdly/workspace-scan";
import type { FileSystem, LocalFile } from "./fs.js";
import { isSyncedSidecarPath, VIEWS_FILE_PATH } from "./sidecarScope.js";

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

/** How many snapshot reads may be in flight at once. */
const READ_CONCURRENCY = 32;

/**
 * SHA-256 lowercase hex via `node:crypto` — byte-identical to `contentHash`
 * in fs.ts (Web Crypto, kept for browser/worker consumers). Strings hash as
 * UTF-8, which is what `TextEncoder` produces too (lone surrogates → U+FFFD
 * in both). Synchronous and far cheaper than a `subtle.digest` round-trip.
 */
export function nodeContentHash(content: string | Uint8Array): string {
	const hash = createHash("sha256");
	if (typeof content === "string") hash.update(content, "utf8");
	else hash.update(content);
	return hash.digest("hex");
}

/**
 * Runs `read` for every path with at most READ_CONCURRENCY in flight and
 * returns results in input order. Error semantics match the old serial
 * loop: an ENOENT drops that path (walk-then-read race), and any other
 * error is rethrown — the one from the EARLIEST failing path in input
 * order, which is the one the serial loop would have hit first.
 */
async function readInOrder<T>(
	paths: readonly string[],
	read: (relativePath: string) => Promise<T>,
): Promise<T[]> {
	const settled: PromiseSettledResult<T>[] = new Array(paths.length);
	let next = 0;
	async function worker() {
		while (next < paths.length) {
			const index = next++;
			try {
				settled[index] = {
					status: "fulfilled",
					value: await read(paths[index]),
				};
			} catch (reason) {
				settled[index] = { status: "rejected", reason };
			}
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, worker),
	);
	const results: T[] = [];
	for (const outcome of settled) {
		if (outcome.status === "fulfilled") results.push(outcome.value);
		else if (!isEnoent(outcome.reason)) throw outcome.reason;
	}
	return results;
}

/**
 * Prefer the stat snapshot the walk already took (one syscall total, not
 * two); fall back to a direct stat only when the walker predates it (e.g.
 * mocked in tests). mtime is seconds here (walker's clock), not ms —
 * consistent within a version. The stat is a hint only: a failure leaves
 * the fields undefined (a vanished file already failed its read).
 */
async function statHint(
	absolute: string,
	mtime: number | undefined,
	size: number | undefined,
): Promise<{ mtime?: number; size?: number }> {
	if (mtime !== undefined && size !== undefined) return { mtime, size };
	try {
		const st = await stat(absolute);
		return { mtime: Math.floor(st.mtimeMs / 1000), size: st.size };
	} catch {
		return { mtime, size };
	}
}

type WalkDetails =
	| Record<string, { modifiedAt?: number; size?: number } | undefined>
	| undefined;

/** Reads + hashes text files (notes, sidecars) — content is kept because plan()/execute() push and merge it. */
function readTextSnapshot(
	dir: string,
	files: readonly string[],
	details: WalkDetails,
): Promise<LocalFile[]> {
	return readInOrder(files, async (relativePath) => {
		const absolute = join(dir, relativePath);
		const content = await readFile(absolute, "utf-8");
		const hint = await statHint(
			absolute,
			details?.[relativePath]?.modifiedAt,
			details?.[relativePath]?.size,
		);
		return {
			relativePath,
			content,
			hash: nodeContentHash(content),
			mtime: hint.mtime,
			size: hint.size,
		};
	});
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
			// The walk above and this read are two separate passes, so a file
			// (or its parent directory) deleted in between — a real race in a
			// workspace with concurrently-churning content, e.g. active git
			// worktrees — must not fail the whole sync run. Skipping it is
			// safe: sync reconciles it as removed on the next cycle.
			return readTextSnapshot(dir, files, details);
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
			const walked = await sidecarWalker(dir, {
				include: isSyncedSidecarPath,
			});
			const details = walked.details;
			// The walker only covers `.mdly/`; the saved-views file (R24) is the
			// one `.hubble` file sync carries, so it is added by exact path.
			const files = existsSync(join(dir, VIEWS_FILE_PATH))
				? [...walked.files, VIEWS_FILE_PATH]
				: walked.files;
			return readTextSnapshot(dir, files, details);
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
			// Same walk-then-read race as listMarkdownFiles above — skip a file
			// deleted between the two passes rather than failing the sync run.
			return readInOrder(files, async (relativePath) => {
				const absolute = join(dir, relativePath);
				const data = await readFile(absolute);
				const hint = await statHint(
					absolute,
					details?.[relativePath]?.modifiedAt,
					details?.[relativePath]?.size,
				);
				return {
					relativePath,
					hash: nodeContentHash(data),
					mtime: hint.mtime,
					size: hint.size,
				};
			});
		},
	};
}
