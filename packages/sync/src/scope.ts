import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	isExcludedByEntries,
	notesWalker,
	WorkspaceDirectoryLimitError,
	WorkspaceTraversalLimitError,
} from "@mdly/workspace-scan";
import type { FileState, FolderAutoExcludeReason } from "./types.js";

/**
 * Large-workspace scope helpers (D-LW4 + D-LW5): ONE surface over ONE piece
 * of persisted state. First sync IS the pending queue at t=0.
 */

/** A new folder is held pending past this many files OR directories. Directories count because they consume OS watch handles — 900 files across 4,000 folders is what kills the app. */
export const PENDING_FILE_THRESHOLD = 1000;
export const PENDING_DIR_THRESHOLD = 1000;
/** The detector never computes the exact number — "more than 1,000" is the whole message, and bailing keeps the check bounded. */
export const PENDING_BAIL_COUNT = 1001;

/**
 * Gitignore's own convention over the shared exclusion list — SINGLE SOURCE
 * is `@mdly/workspace-scan`'s `isExcludedByEntries` (this package depends on
 * it, so this re-export cannot drift): a bare name (`node_modules`) matches
 * at any depth; an entry containing a separator (`fe/docs`) or a leading
 * slash (`/dist`) is anchored to the workspace root. Built-in defaults stay
 * name-based and unchanged.
 */
export function matchesExcludedPattern(
	relativePosixPath: string,
	patterns: readonly string[],
): boolean {
	return isExcludedByEntries(relativePosixPath, patterns);
}

/**
 * Normalizes a raw exclusion list into what gets persisted: entries trimmed,
 * blanks dropped, duplicates removed, original order kept. Anchored paths
 * (`fe/docs`) and leading-slash anchors (`/dist`, gitignore meaning:
 * root-anchored) are preserved as written — a selection UI inherently
 * produces paths, and stripping the slash would silently change "root only"
 * into "anywhere".
 */
export function normalizeExcludedEntries(entries: readonly string[]): string[] {
	const normalized: string[] = [];
	for (const raw of entries) {
		const text = raw.trim().replace(/\\/g, "/");
		const anchored = text.startsWith("/");
		const entry = text.replace(/^\/+|\/+$/g, "");
		if (entry === "") continue;
		if (entry === "." || entry.startsWith("../") || entry.includes("//"))
			throw new Error(
				`"${raw.trim()}" is not a valid exclusion — use a folder name (matches at any depth) or a workspace-relative path like "fe/docs" (a leading slash anchors it to the workspace root).`,
			);
		const stored = anchored ? `/${entry}` : entry;
		if (!normalized.includes(stored)) normalized.push(stored);
	}
	return normalized;
}

/**
 * Cheap-change-detection hint (Tier 1.2): stat match means "might be
 * unchanged" — the caller still verifies by hash when it matters. Stat
 * mismatch ALWAYS means "might have changed → verify". Never proof.
 */
export function isUnchangedByStat(
	prev: FileState | undefined,
	mtime: number | undefined,
	size: number | undefined,
): boolean {
	if (!prev) return false;
	if (prev.mtime === undefined || prev.size === undefined) return false;
	if (mtime === undefined || size === undefined) return false;
	return prev.mtime === mtime && prev.size === size;
}

/**
 * True when `absDir` is a repository/worktree boundary: `.git` present as a
 * directory (plain repo) or as a file (worktree gitlink) — either counts.
 */
export function hasGitMarker(absDir: string): boolean {
	try {
		statSync(join(absDir, ".git"));
		return true;
	} catch {
		return false;
	}
}

export type SubtreeCount = {
	files: number;
	dirs: number;
	/** True when the walk stopped early — counts are lower bounds ("at least"). */
	bailed: boolean;
	isNestedRepo: boolean;
};

/**
 * Counts a subtree with an early bail at 1,001 files/dirs. Never computes
 * the exact number — "more than 1,000" is the sufficient message, and
 * bailing keeps the safety check bounded (otherwise the detection walk
 * costs the same as the sync it was trying to avoid).
 */
export function countSubtreeWithEarlyBail(
	workspaceRoot: string,
	relativeDir: string,
	bailAt: number = PENDING_BAIL_COUNT,
): SubtreeCount {
	const start = join(workspaceRoot, relativeDir);
	let files = 0;
	let dirs = 0;
	let bailed = false;
	const isNestedRepo = start !== workspaceRoot && hasGitMarker(start);

	if (!existsSync(start))
		return { files: 0, dirs: 0, bailed: false, isNestedRepo: false };

	const stack: string[] = [start];
	while (stack.length > 0) {
		if (files >= bailAt || dirs >= bailAt) {
			bailed = true;
			break;
		}
		const dir = stack.pop() as string;
		let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				dirs++;
				if (dirs >= bailAt || files >= bailAt) {
					bailed = true;
					break;
				}
				// Skip nested repos' internals — they are auto-excluded anyway.
				if (entry.name === ".git") continue;
				stack.push(join(dir, entry.name));
			} else if (entry.isFile()) {
				files++;
				if (files >= bailAt || dirs >= bailAt) {
					bailed = true;
					break;
				}
			}
		}
	}
	return { files, dirs, bailed, isNestedRepo };
}

/** True when a counted subtree trips the pending threshold. */
export function isOverPendingThreshold(
	count: Pick<SubtreeCount, "files" | "dirs">,
): boolean {
	return (
		count.files > PENDING_FILE_THRESHOLD || count.dirs > PENDING_DIR_THRESHOLD
	);
}

export type ExcludedTopInfo = {
	reason: FolderAutoExcludeReason;
	/** Markdown-file lower bound for the greyed row ("1,001+" when the bounded count bails). */
	fileCountAtLeast: number;
	bytes: number;
};

/**
 * Classifies one excluded top-level dir with its REAL reason — most
 * informative first: a repo/worktree boundary, then over-threshold, else
 * the ignore mechanism itself. Counts markdown notes through the SAME
 * `notesWalker` the sync uses (nested `.gitignore` honored), bounded by
 * the traversal caps — a huge excluded tree reports "1,001+" instead of
 * being walked exactly.
 */
export async function classifyExcludedTop(
	workspaceRoot: string,
	relTop: string,
): Promise<ExcludedTopInfo> {
	if (hasGitMarker(join(workspaceRoot, relTop))) {
		const md = await countMarkdownBounded(workspaceRoot, relTop);
		return { reason: "nested-repo", ...md };
	}
	const count = countSubtreeWithEarlyBail(workspaceRoot, relTop);
	if (isOverPendingThreshold(count)) {
		return {
			reason: "over-threshold",
			fileCountAtLeast: count.files,
			bytes: 0,
		};
	}
	const md = await countMarkdownBounded(workspaceRoot, relTop);
	return { reason: "gitignored", ...md };
}

async function countMarkdownBounded(
	workspaceRoot: string,
	relTop: string,
): Promise<{ fileCountAtLeast: number; bytes: number }> {
	try {
		const result = await notesWalker(join(workspaceRoot, relTop), {
			maxEntries: PENDING_BAIL_COUNT,
			maxDirectories: PENDING_BAIL_COUNT,
		});
		let bytes = 0;
		for (const rel of result.files) bytes += result.details?.[rel]?.size ?? 0;
		return { fileCountAtLeast: result.files.length, bytes };
	} catch (error) {
		if (
			error instanceof WorkspaceTraversalLimitError ||
			error instanceof WorkspaceDirectoryLimitError
		) {
			return { fileCountAtLeast: PENDING_BAIL_COUNT, bytes: 0 };
		}
		throw error;
	}
}
