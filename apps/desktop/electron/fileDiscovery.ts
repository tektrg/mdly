import fs from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import type {
	DirectoryListing,
	FileEntry,
	FolderEntry,
} from "../src/desktopApi/types";
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
	symlink_target_in_workspace?: boolean;
	symlink_canonical_path?: string | null;
};

type PendingSymlinkMetadata = {
	targetRealPath: string;
	symlinkTarget: string | null;
	listingEntry: FileEntry | FolderEntry;
};

type DiscoveryContext = {
	/** Literal (non-realpath'd) root dir — entryPath strings are built from this, so
	 * ignore-path checks must compare against it rather than workspaceRealPath, which
	 * can diverge when the root itself sits behind a symlink (e.g. macOS tmp dirs). */
	workspaceRootPath: string;
	workspaceRealPath: string;
	canonicalPathByRealPath: Map<string, string>;
	visitedRealPaths: Set<string>;
	pendingSymlinkMetadata: PendingSymlinkMetadata[];
};

export type DocumentDiscoveryOptions = {
	includeIgnoredWorkspaceFiles?: boolean;
};

const ignoreConfigFiles = [".gitignore", ".ignore"];
const ignoredWorkspaceDirs = new Set([
	".dev-electron",
	".git",
	"dist",
	"node_modules",
]);

/**
 * Covers always-ignored workspace dirs in case Git ignores do not catch them.
 * Only segments below the workspace root count — if the workspace itself is
 * nested inside a folder like `.dev-electron`, that ancestor segment must not
 * cause every file in the workspace to be ignored.
 */
function isAlwaysIgnoredWorkspacePath(
	candidatePath: string,
	workspaceRootPath: string,
): boolean {
	const relative = path.relative(workspaceRootPath, candidatePath);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
		return false;
	}
	return relative
		.split(/[\\/]+/)
		.some((segment) => ignoredWorkspaceDirs.has(segment));
}

function toIgnorePath(input: string): string {
	return input.split(path.sep).join("/");
}

function isIgnoredByRules(
	candidatePath: string,
	rules: IgnoreRule[],
	workspaceRootPath: string,
) {
	if (isAlwaysIgnoredWorkspacePath(candidatePath, workspaceRootPath)) return true;

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

function isPathInside(parentPath: string, candidatePath: string): boolean {
	const relative = path.relative(parentPath, candidatePath);
	return (
		relative === "" ||
		(Boolean(relative) &&
			!relative.startsWith("..") &&
			!path.isAbsolute(relative))
	);
}

function symlinkTargetInfo(
	target: string | null,
	targetRealPath: string | null,
	context: DiscoveryContext,
): Pick<SymlinkInfo, "symlink_target_in_workspace" | "symlink_canonical_path"> {
	if (!targetRealPath) {
		return {
			symlink_target_in_workspace: target
				? isPathInside(context.workspaceRealPath, path.resolve(target))
				: false,
			symlink_canonical_path: null,
		};
	}
	const canonicalPath = context.canonicalPathByRealPath.get(targetRealPath);
	const inWorkspace =
		Boolean(canonicalPath) ||
		isPathInside(context.workspaceRealPath, targetRealPath);
	return {
		symlink_target_in_workspace: inWorkspace,
		symlink_canonical_path: canonicalPath ?? null,
	};
}

async function readSymlinkInfo(
	entryPath: string,
	context: DiscoveryContext,
): Promise<SymlinkInfo> {
	try {
		const target = await fs.readlink(entryPath);
		const resolvedTarget = path.resolve(path.dirname(entryPath), target);
		return {
			is_symlink: true,
			symlink_target: resolvedTarget,
			symlink_target_exists: true,
			...symlinkTargetInfo(resolvedTarget, null, context),
		};
	} catch (error) {
		if (isMissingPathError(error)) {
			return {
				is_symlink: true,
				symlink_target: null,
				symlink_target_exists: false,
				symlink_target_in_workspace: false,
				symlink_canonical_path: null,
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

async function createDiscoveryContext(
	rootDir: string,
): Promise<DiscoveryContext> {
	const workspaceRealPath = await fs.realpath(rootDir);
	return {
		workspaceRootPath: rootDir,
		workspaceRealPath,
		canonicalPathByRealPath: new Map(),
		visitedRealPaths: new Set(),
		pendingSymlinkMetadata: [],
	};
}

async function finalizePendingSymlinks(
	context: DiscoveryContext,
) {
	for (const pending of context.pendingSymlinkMetadata) {
		Object.assign(
			pending.listingEntry,
			symlinkTargetInfo(pending.symlinkTarget, pending.targetRealPath, context),
		);
	}
}

export async function collectDocumentFiles(
	dir: string,
	out: DirectoryListing,
	options: DocumentDiscoveryOptions = {},
	inheritedRules: IgnoreRule[] = [],
	context?: DiscoveryContext,
) {
	const isRootCall = !context;
	context ??= await createDiscoveryContext(dir);
	const realDir = await fs.realpath(dir);
	if (context.visitedRealPaths.has(realDir)) return;
	context.visitedRealPaths.add(realDir);
	context.canonicalPathByRealPath.set(realDir, dir);

	const includeIgnoredWorkspaceFiles =
		options.includeIgnoredWorkspaceFiles ?? false;
	const rules = includeIgnoredWorkspaceFiles
		? inheritedRules
		: await rulesForDir(dir, inheritedRules);
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);
		if (includeIgnoredWorkspaceFiles) {
			if (isAlwaysIgnoredWorkspacePath(entryPath, context.workspaceRootPath))
				continue;
		} else if (isIgnoredByRules(entryPath, rules, context.workspaceRootPath)) {
			continue;
		}
		if (entry.isSymbolicLink()) {
			const linkStat = await fs.lstat(entryPath);
			const symlinkInfo = await readSymlinkInfo(entryPath, context);
			let targetStat: Awaited<ReturnType<typeof fs.stat>> | null = null;
			let targetRealPath: string | null = null;
			if (symlinkInfo.symlink_target_exists) {
				try {
					targetStat = await fs.stat(entryPath);
					targetRealPath = await fs.realpath(entryPath);
					Object.assign(
						symlinkInfo,
						symlinkTargetInfo(
							symlinkInfo.symlink_target ?? null,
							targetRealPath,
							context,
						),
					);
				} catch (error) {
					if (!isMissingPathError(error)) throw error;
					symlinkInfo.symlink_target_exists = false;
					symlinkInfo.symlink_target_in_workspace = false;
					symlinkInfo.symlink_canonical_path = null;
				}
			}
			if (targetStat?.isDirectory()) {
				if (isHiddenSidebarFolderName(entry.name)) continue;
				out.folders.push({
					path: entryPath,
					modified_at: modifiedAtSeconds(targetStat),
					...symlinkInfo,
				});
				if (targetRealPath) {
					context.pendingSymlinkMetadata.push({
						targetRealPath,
						symlinkTarget: symlinkInfo.symlink_target ?? null,
						listingEntry: out.folders[out.folders.length - 1],
					});
				}
			} else if (targetStat?.isFile() && isDocumentPath(entry.name)) {
				out.files.push({
					path: entryPath,
					modified_at: modifiedAtSeconds(targetStat),
					...symlinkInfo,
				});
				if (targetRealPath) {
					context.pendingSymlinkMetadata.push({
						targetRealPath,
						symlinkTarget: symlinkInfo.symlink_target ?? null,
						listingEntry: out.files[out.files.length - 1],
					});
				}
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
				context,
			);
		} else if (isDocumentPath(entry.name)) {
			const stat = await fs.stat(entryPath);
			context.canonicalPathByRealPath.set(await fs.realpath(entryPath), entryPath);
			out.files.push({
				path: entryPath,
				modified_at: modifiedAtSeconds(stat),
			});
		}
	}

	if (isRootCall) {
		await finalizePendingSymlinks(context);
	}
}
