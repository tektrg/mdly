import fs from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import type { DirectoryListing } from "../src/desktopApi/types";
import {
	hasDocumentExtension,
	isHiddenSidebarFolderName,
} from "../src/lib/filePath";

type IgnoreRule = {
	dir: string;
	matcher: ReturnType<typeof ignore>;
};

type SymlinkInfo = {
	is_symlink?: true;
	symlink_target?: string | null;
	symlink_target_exists?: boolean;
};

export type DocumentDiscoveryOptions = {
	includeIgnoredWorkspaceFiles?: boolean;
};

const ignoreConfigFiles = [".gitignore", ".ignore"];
const ignoredWorkspaceDirs = new Set([".git", "dist", "node_modules"]);

/** Covers always-ignored workspace dirs in case Git ignores do not catch them. */
function isAlwaysIgnoredWorkspacePath(candidatePath: string): boolean {
	return candidatePath
		.split(/[\\/]+/)
		.some((segment) => ignoredWorkspaceDirs.has(segment));
}

function toIgnorePath(input: string): string {
	return input.split(path.sep).join("/");
}

function isIgnoredByRules(candidatePath: string, rules: IgnoreRule[]) {
	if (isAlwaysIgnoredWorkspacePath(candidatePath)) return true;

	let ignored = false;
	for (const { dir, matcher } of rules) {
		const relative = path.relative(dir, candidatePath);
		if (
			relative === "" ||
			relative.startsWith("..") ||
			path.isAbsolute(relative)
		)
			continue;
		const ignorePath = toIgnorePath(relative);
		const result = matcher.test(ignorePath);
		const directoryResult = matcher.test(`${ignorePath}/`);
		if (result.ignored || directoryResult.ignored) ignored = true;
		if (result.unignored || directoryResult.unignored) ignored = false;
	}
	return ignored;
}

function isDocumentPath(candidatePath: string): boolean {
	return hasDocumentExtension(candidatePath);
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

function modifiedAtSeconds(stat: { mtimeMs: number | bigint }): number {
	return Math.floor(Number(stat.mtimeMs) / 1000);
}

async function readSymlinkInfo(entryPath: string): Promise<SymlinkInfo> {
	try {
		const target = await fs.readlink(entryPath);
		return {
			is_symlink: true,
			symlink_target: path.resolve(path.dirname(entryPath), target),
			symlink_target_exists: true,
		};
	} catch (error) {
		if (isMissingPathError(error)) {
			return {
				is_symlink: true,
				symlink_target: null,
				symlink_target_exists: false,
			};
		}
		throw error;
	}
}

async function rulesForDir(dir: string, inherited: IgnoreRule[]) {
	const matcher = ignore();
	let hasRules = false;

	for (const fileName of ignoreConfigFiles) {
		try {
			matcher.add(await fs.readFile(path.join(dir, fileName), "utf8"));
			hasRules = true;
		} catch (error) {
			if (isMissingPathError(error)) continue;
			throw error;
		}
	}

	return hasRules ? [...inherited, { dir, matcher }] : inherited;
}

export async function collectDocumentFiles(
	dir: string,
	out: DirectoryListing,
	options: DocumentDiscoveryOptions = {},
	inheritedRules: IgnoreRule[] = [],
	visitedRealPaths: Set<string> = new Set(),
) {
	const realDir = await fs.realpath(dir);
	if (visitedRealPaths.has(realDir)) return;
	visitedRealPaths.add(realDir);

	const includeIgnoredWorkspaceFiles =
		options.includeIgnoredWorkspaceFiles ?? false;
	const rules = includeIgnoredWorkspaceFiles
		? inheritedRules
		: await rulesForDir(dir, inheritedRules);
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);
		if (includeIgnoredWorkspaceFiles) {
			if (isAlwaysIgnoredWorkspacePath(entryPath)) continue;
		} else if (isIgnoredByRules(entryPath, rules)) {
			continue;
		}
		if (entry.isSymbolicLink()) {
			const linkStat = await fs.lstat(entryPath);
			const symlinkInfo = await readSymlinkInfo(entryPath);
			let targetStat: Awaited<ReturnType<typeof fs.stat>> | null = null;
			if (symlinkInfo.symlink_target_exists) {
				try {
					targetStat = await fs.stat(entryPath);
				} catch (error) {
					if (!isMissingPathError(error)) throw error;
					symlinkInfo.symlink_target_exists = false;
				}
			}
			if (targetStat?.isDirectory()) {
				if (isHiddenSidebarFolderName(entry.name)) continue;
				out.folders.push({
					path: entryPath,
					modified_at: modifiedAtSeconds(targetStat),
					...symlinkInfo,
				});
				await collectDocumentFiles(
					entryPath,
					out,
					options,
					rules,
					visitedRealPaths,
				);
			} else if (targetStat?.isFile() && isDocumentPath(entry.name)) {
				out.files.push({
					path: entryPath,
					modified_at: modifiedAtSeconds(targetStat),
					...symlinkInfo,
				});
			} else if (!targetStat && !symlinkInfo.symlink_target_exists) {
				const brokenEntry = {
					path: entryPath,
					modified_at: modifiedAtSeconds(linkStat),
					...symlinkInfo,
				};
				if (isDocumentPath(entryPath)) out.files.push(brokenEntry);
				else if (!isHiddenSidebarFolderName(entry.name))
					out.folders.push(brokenEntry);
			}
		} else if (entry.isDirectory()) {
			if (isHiddenSidebarFolderName(entry.name)) continue;
			const stat = await fs.stat(entryPath);
			out.folders.push({
				path: entryPath,
				modified_at: modifiedAtSeconds(stat),
			});
			await collectDocumentFiles(
				entryPath,
				out,
				options,
				rules,
				visitedRealPaths,
			);
		} else if (isDocumentPath(entry.name)) {
			const stat = await fs.stat(entryPath);
			out.files.push({
				path: entryPath,
				modified_at: modifiedAtSeconds(stat),
			});
		}
	}
}
