import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { WalkerErrorEntry, WalkerResult } from "./types.js";

const SIDECAR_DIR_NAME = ".mdly";
// Hard-excluded per R13/R18 — these are the content-addressed revision
// blobs, never synced, discovery-only or otherwise.
const EXCLUDED_SUBTREE_SEGMENTS = [SIDECAR_DIR_NAME, "history", "objects"];

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Optional narrowing predicate over workspace-relative, POSIX-separated
 * paths. Applied AFTER the hard `.mdly/history/objects/**` exclusion below,
 * so no include can ever re-admit the revision blobs (second belt).
 */
export interface SidecarWalkerOptions {
	include?: (workspaceRelativePath: string) => boolean;
}

/**
 * The cloud-sync "sidecars" walker (R13): `.mdly/**\/*.jsonl` only.
 *
 * Deliberately bypasses `.gitignore` / `.ignore` entirely — this is
 * app-private data the user never means to gitignore — and hard-excludes
 * `.mdly/history/objects/**`, the content-addressed revision blobs.
 *
 * `details`/`stats` match `notesWalker`'s shape exactly: per-file
 * `{ size, modifiedAt }` with `modifiedAt` in SECONDS (not ms), so sync's
 * cheap-stat skip can compare directly against `fs-node`'s
 * `Math.floor(mtimeMs / 1000)` hint.
 *
 * Per D9/R18, in Phase 1 this walker feeds ONLY the dry-run report; nothing
 * in this package pushes or pulls what it finds.
 */
export async function sidecarWalker(
	workspaceRoot: string,
	options?: SidecarWalkerOptions,
): Promise<WalkerResult> {
	const root = path.resolve(workspaceRoot);
	const sidecarRoot = path.join(root, SIDECAR_DIR_NAME);
	const files: string[] = [];
	const errors: WalkerErrorEntry[] = [];
	const details: Record<string, { size: number; modifiedAt: number }> = {};
	const stats = { visitedEntryCount: 0, visitedDirectoryCount: 0 };

	await walk(sidecarRoot, root, files, errors, details, stats, options?.include);
	files.sort();
	return { files, errors, stats, details };
}

function isExcludedSubtree(relativeSegments: string[]): boolean {
	if (relativeSegments.length < EXCLUDED_SUBTREE_SEGMENTS.length) return false;
	return EXCLUDED_SUBTREE_SEGMENTS.every(
		(segment, index) => relativeSegments[index] === segment,
	);
}

async function walk(
	dir: string,
	root: string,
	files: string[],
	errors: WalkerErrorEntry[],
	details: Record<string, { size: number; modifiedAt: number }>,
	stats: { visitedEntryCount: number; visitedDirectoryCount: number },
	include: SidecarWalkerOptions["include"],
): Promise<void> {
	let entries: Dirent[];
	try {
		entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
			a.name.localeCompare(b.name),
		);
	} catch (error) {
		// No .mdly folder at all is normal (not every workspace has comments
		// yet) — only report genuinely unexpected read failures (R15).
		if (!isMissingPathError(error)) {
			errors.push({ path: dir, message: errorMessage(error) });
		}
		return;
	}
	stats.visitedDirectoryCount += 1;

	for (const entry of entries) {
		stats.visitedEntryCount += 1;
		const entryPath = path.join(dir, entry.name);
		const relativeSegments = path.relative(root, entryPath).split(path.sep);
		if (isExcludedSubtree(relativeSegments)) continue;

		let isDirectory = entry.isDirectory();
		let isFile = entry.isFile();
		// Symlink targets are stat'ed for type resolution; reuse that same
		// stat below for details so symlinked sidecars cost one syscall.
		let linkStat: Stats | undefined;
		if (entry.isSymbolicLink()) {
			try {
				linkStat = await fs.stat(entryPath);
				isDirectory = linkStat.isDirectory();
				isFile = linkStat.isFile();
			} catch (error) {
				if (!isMissingPathError(error)) {
					errors.push({ path: entryPath, message: errorMessage(error) });
				}
				continue; // broken symlink — skip quietly (R15)
			}
		}

		if (isDirectory) {
			await walk(entryPath, root, files, errors, details, stats, include);
			continue;
		}
		if (isFile && entry.name.toLowerCase().endsWith(".jsonl")) {
			const relativePath = relativeSegments.join("/");
			// Caller narrowing runs second: the objects exclusion above
			// already fired, so include can never re-admit a revision blob.
			if (include && !include(relativePath)) continue;
			try {
				const stat = linkStat ?? (await fs.stat(entryPath));
				// SECONDS, not ms — must match notesWalker's modified_at and
				// fs-node's Math.floor(mtimeMs / 1000), or the cheap-stat
				// skip never fires and every log is re-read + re-hashed.
				details[relativePath] = {
					size: stat.size,
					modifiedAt: Math.floor(stat.mtimeMs / 1000),
				};
				files.push(relativePath);
			} catch (error) {
				// Walk-then-stat race (file deleted in between): skip
				// quietly on ENOENT, report anything genuinely unexpected.
				if (!isMissingPathError(error)) {
					errors.push({ path: entryPath, message: errorMessage(error) });
				}
			}
		}
	}
}
