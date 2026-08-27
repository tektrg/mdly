import fs from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";

export type WorkspaceSymlinkInfo = {
	is_symlink?: true;
	symlink_target?: string | null;
	symlink_target_exists?: boolean;
	symlink_target_in_workspace?: boolean;
	symlink_canonical_path?: string | null;
};

export type WorkspaceFileEntry = WorkspaceSymlinkInfo & {
	path: string;
	modified_at: number;
};

export type WorkspaceFolderEntry = WorkspaceFileEntry;

export type WorkspaceDiscoveryStats = {
	visitedEntryCount: number;
	ignoredDirectoryCount: number;
	ignoredFileCount: number;
	durationMs: number;
};

export type WorkspaceDiscoveryResult = {
	files: WorkspaceFileEntry[];
	folders: WorkspaceFolderEntry[];
	stats: WorkspaceDiscoveryStats;
	isIgnoredPath: (candidatePath: string) => boolean;
};

export type WorkspaceDiscoveryOptions = {
	workspaceRoot: string;
	isSupportedFile: (candidatePath: string) => boolean;
	includeIgnoredWorkspaceFiles?: boolean;
	alwaysIgnoredDirectoryNames?: Iterable<string>;
	maxEntries?: number;
	signal?: AbortSignal;
	isVisibleFolderName?: (folderName: string) => boolean;
};

type IgnoreRule = {
	dir: string;
	matcher: ReturnType<typeof ignore>;
};

type PendingSymlinkMetadata = {
	targetRealPath: string;
	symlinkTarget: string | null;
	listingEntry: WorkspaceFileEntry | WorkspaceFolderEntry;
};

type DiscoveryContext = {
	workspaceRootPath: string;
	workspaceRealPath: string;
	canonicalPathByRealPath: Map<string, string>;
	visitedRealPaths: Set<string>;
	pendingSymlinkMetadata: PendingSymlinkMetadata[];
	allIgnoreRules: IgnoreRule[];
	alwaysIgnoredDirectoryNames: ReadonlySet<string>;
	startedAtMs: number;
	stats: Omit<WorkspaceDiscoveryStats, "durationMs">;
};

const IGNORE_CONFIG_FILES = [".gitignore", ".ignore"];

export const ALWAYS_IGNORED_WORKSPACE_DIRECTORY_NAMES = new Set([
	".dev-electron",
	".git",
	"dist",
	"node_modules",
]);

export class WorkspaceTraversalLimitError extends Error {
	readonly code = "WORKSPACE_TRAVERSAL_LIMIT";

	constructor(
		readonly limit: number,
		readonly visitedEntryCount: number,
	) {
		super(`Workspace contains more than ${limit.toLocaleString()} traversable entries`);
		this.name = "WorkspaceTraversalLimitError";
	}
}

export function isAlwaysIgnoredWorkspacePath(
	candidatePath: string,
	workspaceRootPath: string,
	directoryNames: ReadonlySet<string> = ALWAYS_IGNORED_WORKSPACE_DIRECTORY_NAMES,
): boolean {
	const relative = path.relative(workspaceRootPath, candidatePath);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
		return false;
	}
	return relative
		.split(/[\\/]+/)
		.some((segment) => directoryNames.has(segment));
}

function toIgnorePath(input: string): string {
	return input.split(path.sep).join("/");
}

function isIgnoredByRules(
	candidatePath: string,
	rules: IgnoreRule[],
	workspaceRootPath: string,
	alwaysIgnoredDirectoryNames: ReadonlySet<string>,
): boolean {
	if (
		isAlwaysIgnoredWorkspacePath(
			candidatePath,
			workspaceRootPath,
			alwaysIgnoredDirectoryNames,
		)
	) {
		return true;
	}

	let ignored = false;
	for (const { dir, matcher } of rules) {
		const relative = path.relative(dir, candidatePath);
		if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
			continue;
		}
		const ignorePath = toIgnorePath(relative);
		const result = matcher.test(ignorePath);
		const directoryResult = matcher.test(`${ignorePath}/`);
		if (result.ignored || directoryResult.ignored) ignored = true;
		if (result.unignored || directoryResult.unignored) ignored = false;
	}
	return ignored;
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
		(Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

function symlinkTargetInfo(
	target: string | null,
	targetRealPath: string | null,
	context: DiscoveryContext,
): Pick<WorkspaceSymlinkInfo, "symlink_target_in_workspace" | "symlink_canonical_path"> {
	if (!targetRealPath) {
		return {
			symlink_target_in_workspace: target
				? isPathInside(context.workspaceRealPath, path.resolve(target))
				: false,
			symlink_canonical_path: null,
		};
	}
	const canonicalPath = context.canonicalPathByRealPath.get(targetRealPath);
	return {
		symlink_target_in_workspace:
			Boolean(canonicalPath) || isPathInside(context.workspaceRealPath, targetRealPath),
		symlink_canonical_path: canonicalPath ?? null,
	};
}

async function readSymlinkInfo(
	entryPath: string,
	context: DiscoveryContext,
): Promise<WorkspaceSymlinkInfo> {
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

async function rulesForDirectory(
	dir: string,
	inheritedRules: IgnoreRule[],
	context: DiscoveryContext,
): Promise<IgnoreRule[]> {
	const matcher = ignore();
	let hasRules = false;
	for (const fileName of IGNORE_CONFIG_FILES) {
		try {
			matcher.add(await fs.readFile(path.join(dir, fileName), "utf8"));
			hasRules = true;
		} catch (error) {
			if (isMissingPathError(error)) continue;
			throw error;
		}
	}
	if (!hasRules) return inheritedRules;
	const nextRule = { dir, matcher };
	context.allIgnoreRules.push(nextRule);
	return [...inheritedRules, nextRule];
}

function throwIfTraversalStopped(options: WorkspaceDiscoveryOptions, context: DiscoveryContext) {
	if (options.signal?.aborted) {
		throw options.signal.reason ?? new DOMException("Workspace discovery aborted", "AbortError");
	}
	context.stats.visitedEntryCount += 1;
	if (
		options.maxEntries !== undefined &&
		context.stats.visitedEntryCount > options.maxEntries
	) {
		throw new WorkspaceTraversalLimitError(
			options.maxEntries,
			context.stats.visitedEntryCount,
		);
	}
}

async function walkDirectory(
	dir: string,
	options: WorkspaceDiscoveryOptions,
	files: WorkspaceFileEntry[],
	folders: WorkspaceFolderEntry[],
	inheritedRules: IgnoreRule[],
	context: DiscoveryContext,
): Promise<void> {
	if (options.signal?.aborted) {
		throw options.signal.reason ?? new DOMException("Workspace discovery aborted", "AbortError");
	}
	const realDir = await fs.realpath(dir);
	if (context.visitedRealPaths.has(realDir)) return;
	context.visitedRealPaths.add(realDir);
	context.canonicalPathByRealPath.set(realDir, dir);

	const rules = options.includeIgnoredWorkspaceFiles
		? inheritedRules
		: await rulesForDirectory(dir, inheritedRules, context);
	const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((left, right) =>
		left.name.localeCompare(right.name),
	);
	for (const entry of entries) {
		throwIfTraversalStopped(options, context);
		const entryPath = path.join(dir, entry.name);
		const ignored = options.includeIgnoredWorkspaceFiles
			? isAlwaysIgnoredWorkspacePath(
					entryPath,
					context.workspaceRootPath,
					context.alwaysIgnoredDirectoryNames,
				)
			: isIgnoredByRules(
					entryPath,
					rules,
					context.workspaceRootPath,
					context.alwaysIgnoredDirectoryNames,
				);
		if (ignored) {
			if (entry.isDirectory()) context.stats.ignoredDirectoryCount += 1;
			else context.stats.ignoredFileCount += 1;
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
						symlinkTargetInfo(symlinkInfo.symlink_target ?? null, targetRealPath, context),
					);
				} catch (error) {
					if (!isMissingPathError(error)) throw error;
					symlinkInfo.symlink_target_exists = false;
					symlinkInfo.symlink_target_in_workspace = false;
					symlinkInfo.symlink_canonical_path = null;
				}
			}
			if (targetStat?.isDirectory()) {
				if (options.isVisibleFolderName && !options.isVisibleFolderName(entry.name)) continue;
				folders.push({ path: entryPath, modified_at: modifiedAtSeconds(targetStat), ...symlinkInfo });
				if (targetRealPath) {
					context.pendingSymlinkMetadata.push({
						targetRealPath,
						symlinkTarget: symlinkInfo.symlink_target ?? null,
						listingEntry: folders[folders.length - 1],
					});
				}
			} else if (targetStat?.isFile() && options.isSupportedFile(entryPath)) {
				files.push({ path: entryPath, modified_at: modifiedAtSeconds(targetStat), ...symlinkInfo });
				if (targetRealPath) {
					context.pendingSymlinkMetadata.push({
						targetRealPath,
						symlinkTarget: symlinkInfo.symlink_target ?? null,
						listingEntry: files[files.length - 1],
					});
				}
			} else if (!targetStat && !symlinkInfo.symlink_target_exists) {
				const brokenEntry = { path: entryPath, modified_at: modifiedAtSeconds(linkStat), ...symlinkInfo };
				if (options.isSupportedFile(entryPath)) files.push(brokenEntry);
				else if (!options.isVisibleFolderName || options.isVisibleFolderName(entry.name)) {
					folders.push(brokenEntry);
				}
			}
			continue;
		}

		if (entry.isDirectory()) {
			if (options.isVisibleFolderName && !options.isVisibleFolderName(entry.name)) continue;
			const stat = await fs.stat(entryPath);
			folders.push({ path: entryPath, modified_at: modifiedAtSeconds(stat) });
			await walkDirectory(entryPath, options, files, folders, rules, context);
			continue;
		}
		if (!entry.isFile() || !options.isSupportedFile(entryPath)) continue;
		const stat = await fs.stat(entryPath);
		context.canonicalPathByRealPath.set(await fs.realpath(entryPath), entryPath);
		files.push({ path: entryPath, modified_at: modifiedAtSeconds(stat) });
	}
}

export async function discoverWorkspaceFiles(
	options: WorkspaceDiscoveryOptions,
): Promise<WorkspaceDiscoveryResult> {
	const workspaceRoot = path.resolve(options.workspaceRoot);
	const alwaysIgnoredDirectoryNames = new Set([
		...ALWAYS_IGNORED_WORKSPACE_DIRECTORY_NAMES,
		...(options.alwaysIgnoredDirectoryNames ?? []),
	]);
	const context: DiscoveryContext = {
		workspaceRootPath: workspaceRoot,
		workspaceRealPath: await fs.realpath(workspaceRoot),
		canonicalPathByRealPath: new Map(),
		visitedRealPaths: new Set(),
		pendingSymlinkMetadata: [],
		allIgnoreRules: [],
		alwaysIgnoredDirectoryNames,
		startedAtMs: Date.now(),
		stats: { visitedEntryCount: 0, ignoredDirectoryCount: 0, ignoredFileCount: 0 },
	};
	const files: WorkspaceFileEntry[] = [];
	const folders: WorkspaceFolderEntry[] = [];
	await walkDirectory(workspaceRoot, options, files, folders, [], context);

	for (const pending of context.pendingSymlinkMetadata) {
		Object.assign(
			pending.listingEntry,
			symlinkTargetInfo(pending.symlinkTarget, pending.targetRealPath, context),
		);
	}

	return {
		files,
		folders,
		stats: { ...context.stats, durationMs: Date.now() - context.startedAtMs },
		isIgnoredPath: (candidatePath) =>
			options.includeIgnoredWorkspaceFiles
				? isAlwaysIgnoredWorkspacePath(
						candidatePath,
						workspaceRoot,
						alwaysIgnoredDirectoryNames,
					)
				: isIgnoredByRules(
						candidatePath,
						context.allIgnoreRules,
						workspaceRoot,
						alwaysIgnoredDirectoryNames,
					),
	};
}
