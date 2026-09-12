import type { Dirent } from "node:fs";
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
	/** Raw byte size from the `stat` the walk already performed — lets sync use the stat hint without a second syscall per file. */
	size?: number;
};

export type WorkspaceFolderEntry = WorkspaceFileEntry;

/**
 * A single path the walk could not fully inspect (permission denied, a
 * directory that vanished mid-walk, etc). The walk always keeps going past
 * one of these — see R15 in the cloud-review-surface charter — the rest of
 * the workspace is still returned; the bad path is only reported here.
 */
export type WorkspaceDiscoveryError = {
	path: string;
	message: string;
};

export type WorkspaceDiscoveryStats = {
	visitedEntryCount: number;
	visitedDirectoryCount: number;
	ignoredDirectoryCount: number;
	ignoredFileCount: number;
	/** Subtrees pruned as nested repos (D-LW1) — essentially never workspace content. */
	prunedNestedRepoCount: number;
	durationMs: number;
};

export type WorkspaceDiscoveryResult = {
	files: WorkspaceFileEntry[];
	folders: WorkspaceFolderEntry[];
	stats: WorkspaceDiscoveryStats;
	isIgnoredPath: (candidatePath: string) => boolean;
	/** Unreadable paths encountered mid-walk. Never aborts the walk (R15). */
	errors: WorkspaceDiscoveryError[];
};

export type WorkspaceDiscoveryOptions = {
	workspaceRoot: string;
	isSupportedFile: (candidatePath: string) => boolean;
	includeIgnoredWorkspaceFiles?: boolean;
	alwaysIgnoredDirectoryNames?: Iterable<string>;
	maxEntries?: number;
	/**
	 * Caps how many DIRECTORIES the walk visits before throwing
	 * `WorkspaceDirectoryLimitError`. Directories are what consume OS watch
	 * handles — counting entries alone (SYNC_MAX_ENTRIES's old mistake) misses
	 * the watcher's actual constraint.
	 */
	maxDirectories?: number;
	/**
	 * Prune directories containing their own `.git` (repo/worktree boundary,
	 * file or dir) instead of descending — D-LW1. Opt-in so the sidebar's
	 * own listing is untouched; the sync walkers enable it. One `stat` per
	 * directory, not per file.
	 */
	pruneNestedRepos?: boolean;
	signal?: AbortSignal;
	isVisibleFolderName?: (folderName: string) => boolean;
	/**
	 * Called periodically during the walk with live counts — the ONLY
	 * honest indeterminate progress source (no total exists until the walk
	 * ends). Invoked at most every 50 visited entries; never per file.
	 */
	onVisit?: (visited: {
		visitedEntryCount: number;
		visitedDirectoryCount: number;
	}) => void;
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
	/** Full exclusion list (names + anchored paths) for `isExcludedByEntries`. */
	excludedEntries: readonly string[];
	startedAtMs: number;
	stats: Omit<WorkspaceDiscoveryStats, "durationMs">;
	errors: WorkspaceDiscoveryError[];
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
		super(
			`Workspace contains more than ${limit.toLocaleString()} traversable entries`,
		);
		this.name = "WorkspaceTraversalLimitError";
	}
}

/** Thrown when a walk visits more directories than `maxDirectories` — the watcher's actual constraint, not entry count. */
export class WorkspaceDirectoryLimitError extends Error {
	readonly code = "WORKSPACE_DIRECTORY_LIMIT";

	constructor(
		readonly limit: number,
		readonly visitedDirectoryCount: number,
	) {
		super(
			`Workspace contains more than ${limit.toLocaleString()} directories to watch`,
		);
		this.name = "WorkspaceDirectoryLimitError";
	}
}

export function isAlwaysIgnoredWorkspacePath(
	candidatePath: string,
	workspaceRootPath: string,
	directoryNames: ReadonlySet<string> = ALWAYS_IGNORED_WORKSPACE_DIRECTORY_NAMES,
): boolean {
	const relative = path.relative(workspaceRootPath, candidatePath);
	if (
		relative === "" ||
		relative.startsWith("..") ||
		path.isAbsolute(relative)
	) {
		return false;
	}
	return relative
		.split(/[\\/]+/)
		.some((segment) => directoryNames.has(segment));
}

/**
 * Gitignore's own convention over ONE shared list (D-LW4) — SINGLE SOURCE
 * for exclusion matching (`@hubble.md/sync` re-exports this): a bare name
 * (`node_modules`) matches at any depth; an entry containing a separator
 * (`fe/docs`) or a leading slash (`/dist`, gitignore's root-anchor) is
 * anchored to the workspace root.
 */
export function isExcludedByEntries(
	workspaceRelativePosixPath: string,
	entries: readonly string[],
): boolean {
	const rel = workspaceRelativePosixPath.replace(/\\/g, "/");
	const segments = rel.split("/").filter(Boolean);
	for (const raw of entries) {
		const text = raw.trim().replace(/\\/g, "/");
		const anchored = text.startsWith("/");
		const pattern = text.replace(/^\/+|\/+$/g, "");
		if (pattern === "") continue;
		if (anchored || pattern.includes("/")) {
			if (rel === pattern || rel.startsWith(`${pattern}/`)) return true;
		} else if (segments.includes(pattern)) {
			return true;
		}
	}
	return false;
}

function toIgnorePath(input: string): string {
	return input.split(path.sep).join("/");
}

function isIgnoredByRules(
	candidatePath: string,
	rules: IgnoreRule[],
	workspaceRootPath: string,
	alwaysIgnoredDirectoryNames: ReadonlySet<string>,
	excludedEntries?: readonly string[],
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

	if (excludedEntries && excludedEntries.length > 0) {
		const relative = path.relative(workspaceRootPath, candidatePath);
		if (
			relative !== "" &&
			!relative.startsWith("..") &&
			!path.isAbsolute(relative)
		) {
			if (
				isExcludedByEntries(relative.split(path.sep).join("/"), excludedEntries)
			) {
				return true;
			}
		}
	}

	let ignored = false;
	for (const { dir, matcher } of rules) {
		const relative = path.relative(dir, candidatePath);
		if (
			relative === "" ||
			relative.startsWith("..") ||
			path.isAbsolute(relative)
		) {
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Records a path the walk could not inspect, without throwing (R15). */
function recordError(
	context: DiscoveryContext,
	entryPath: string,
	error: unknown,
): void {
	context.errors.push({ path: entryPath, message: errorMessage(error) });
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
): Pick<
	WorkspaceSymlinkInfo,
	"symlink_target_in_workspace" | "symlink_canonical_path"
> {
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
			Boolean(canonicalPath) ||
			isPathInside(context.workspaceRealPath, targetRealPath),
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
		// Anything other than "the link is fine but its target is missing"
		// (e.g. a permission error reading the link itself) is reported and
		// treated as an unresolvable symlink rather than aborting the walk.
		recordError(context, entryPath, error);
		return {
			is_symlink: true,
			symlink_target: null,
			symlink_target_exists: false,
			symlink_target_in_workspace: false,
			symlink_canonical_path: null,
		};
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
	// D-LW1: git's OTHER ignore sources apply at the workspace root. This is
	// the original root cause — git ignored `.claude/worktrees` via
	// `.git/info/exclude`, which mdly never read, so it walked straight in.
	if (dir === context.workspaceRootPath) {
		for (const absoluteFile of rootExtraIgnoreFiles(context)) {
			try {
				matcher.add(await fs.readFile(absoluteFile, "utf8"));
				hasRules = true;
			} catch (error) {
				if (isMissingPathError(error)) continue;
				throw error;
			}
		}
	}
	if (!hasRules) return inheritedRules;
	const nextRule = { dir, matcher };
	context.allIgnoreRules.push(nextRule);
	return [...inheritedRules, nextRule];
}

/**
 * Workspace-root ignore files beyond `.gitignore`/`.ignore`: git's
 * per-clone `.git/info/exclude` plus the global excludes file (git's
 * documented default location — `$XDG_CONFIG_HOME/git/ignore`, else
 * `~/.config/git/ignore`). A custom `core.excludesFile` path is NOT
 * honored (reading it needs a `git config` subprocess per walk); that
 * limitation is documented, not silent: nested-repo pruning below covers
 * the worktree case regardless of which ignore file names it.
 */
export function rootExtraIgnoreFiles(context: {
	workspaceRootPath: string;
}): string[] {
	const files = [
		path.join(context.workspaceRootPath, ".git", "info", "exclude"),
	];
	const xdg = process.env.XDG_CONFIG_HOME;
	const home = process.env.HOME ?? process.env.USERPROFILE;
	const configDir =
		xdg && xdg.length > 0
			? xdg
			: home && home.length > 0
				? path.join(home, ".config")
				: null;
	if (configDir) files.push(path.join(configDir, "git", "ignore"));
	return files;
}

function throwIfTraversalStopped(
	options: WorkspaceDiscoveryOptions,
	context: DiscoveryContext,
) {
	if (options.signal?.aborted) {
		throw (
			options.signal.reason ??
			new DOMException("Workspace discovery aborted", "AbortError")
		);
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
	if (
		options.onVisit !== undefined &&
		context.stats.visitedEntryCount % 50 === 0
	) {
		options.onVisit({
			visitedEntryCount: context.stats.visitedEntryCount,
			visitedDirectoryCount: context.stats.visitedDirectoryCount,
		});
	}
}

function throwIfDirectoryLimitExceeded(
	options: WorkspaceDiscoveryOptions,
	context: DiscoveryContext,
) {
	context.stats.visitedDirectoryCount += 1;
	if (
		options.maxDirectories !== undefined &&
		context.stats.visitedDirectoryCount > options.maxDirectories
	) {
		throw new WorkspaceDirectoryLimitError(
			options.maxDirectories,
			context.stats.visitedDirectoryCount,
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
		throw (
			options.signal.reason ??
			new DOMException("Workspace discovery aborted", "AbortError")
		);
	}

	let realDir: string;
	try {
		realDir = await fs.realpath(dir);
	} catch (error) {
		// The directory disappeared or is unreadable — skip this subtree, keep
		// walking the rest of the workspace (R15).
		recordError(context, dir, error);
		return;
	}
	if (context.visitedRealPaths.has(realDir)) return;
	context.visitedRealPaths.add(realDir);
	context.canonicalPathByRealPath.set(realDir, dir);
	throwIfDirectoryLimitExceeded(options, context);

	// D-LW1 nested-repo boundary: a dir with its own `.git` (file for a
	// worktree gitlink, dir for a plain repo) is essentially never workspace
	// content — prune the whole subtree. Never applies to the workspace root
	// itself. One stat, before the listing read. Any probe failure (missing,
	// unreadable) falls through to the normal walk, which records the real
	// error itself — the probe must never change which path an error is
	// reported against.
	if (options.pruneNestedRepos && dir !== context.workspaceRootPath) {
		let isRepoBoundary = false;
		try {
			await fs.stat(path.join(dir, ".git"));
			isRepoBoundary = true;
		} catch {
			isRepoBoundary = false;
		}
		if (isRepoBoundary) {
			context.stats.prunedNestedRepoCount += 1;
			return;
		}
	}

	let rules: IgnoreRule[];
	try {
		rules = options.includeIgnoredWorkspaceFiles
			? inheritedRules
			: await rulesForDirectory(dir, inheritedRules, context);
	} catch (error) {
		// Reading this directory's own .gitignore/.ignore failed (e.g. the
		// directory itself denies access) — skip this subtree rather than
		// aborting the whole walk (R15).
		recordError(context, dir, error);
		return;
	}

	let entries: Dirent[];
	try {
		entries = (await fs.readdir(dir, { withFileTypes: true })).sort(
			(left, right) => left.name.localeCompare(right.name),
		);
	} catch (error) {
		// Permission denied (or similar) reading this directory's listing —
		// report it and move on rather than aborting the whole walk (R15).
		recordError(context, dir, error);
		return;
	}

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
					context.excludedEntries,
				);
		if (ignored) {
			if (entry.isDirectory()) context.stats.ignoredDirectoryCount += 1;
			else context.stats.ignoredFileCount += 1;
			continue;
		}

		if (entry.isSymbolicLink()) {
			let linkStat: Awaited<ReturnType<typeof fs.lstat>>;
			try {
				linkStat = await fs.lstat(entryPath);
			} catch (error) {
				recordError(context, entryPath, error);
				continue;
			}
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
					if (!isMissingPathError(error))
						recordError(context, entryPath, error);
					symlinkInfo.symlink_target_exists = false;
					symlinkInfo.symlink_target_in_workspace = false;
					symlinkInfo.symlink_canonical_path = null;
				}
			}
			if (targetStat?.isDirectory()) {
				if (
					options.isVisibleFolderName &&
					!options.isVisibleFolderName(entry.name)
				)
					continue;
				folders.push({
					path: entryPath,
					modified_at: modifiedAtSeconds(targetStat),
					...symlinkInfo,
				});
				if (targetRealPath) {
					context.pendingSymlinkMetadata.push({
						targetRealPath,
						symlinkTarget: symlinkInfo.symlink_target ?? null,
						listingEntry: folders[folders.length - 1],
					});
				}
			} else if (targetStat?.isFile() && options.isSupportedFile(entryPath)) {
				files.push({
					path: entryPath,
					modified_at: modifiedAtSeconds(targetStat),
					size: Number(targetStat.size),
					...symlinkInfo,
				});
				if (targetRealPath) {
					context.pendingSymlinkMetadata.push({
						targetRealPath,
						symlinkTarget: symlinkInfo.symlink_target ?? null,
						listingEntry: files[files.length - 1],
					});
				}
			} else if (!targetStat && !symlinkInfo.symlink_target_exists) {
				const brokenEntry = {
					path: entryPath,
					modified_at: modifiedAtSeconds(linkStat),
					...symlinkInfo,
				};
				if (options.isSupportedFile(entryPath)) files.push(brokenEntry);
				else if (
					!options.isVisibleFolderName ||
					options.isVisibleFolderName(entry.name)
				) {
					folders.push(brokenEntry);
				}
			}
			continue;
		}

		if (entry.isDirectory()) {
			if (
				options.isVisibleFolderName &&
				!options.isVisibleFolderName(entry.name)
			)
				continue;
			let stat: Awaited<ReturnType<typeof fs.stat>>;
			try {
				stat = await fs.stat(entryPath);
			} catch (error) {
				recordError(context, entryPath, error);
				continue;
			}
			folders.push({ path: entryPath, modified_at: modifiedAtSeconds(stat) });
			await walkDirectory(entryPath, options, files, folders, rules, context);
			continue;
		}
		if (!entry.isFile() || !options.isSupportedFile(entryPath)) continue;
		let stat: Awaited<ReturnType<typeof fs.stat>>;
		try {
			stat = await fs.stat(entryPath);
		} catch (error) {
			recordError(context, entryPath, error);
			continue;
		}
		try {
			context.canonicalPathByRealPath.set(
				await fs.realpath(entryPath),
				entryPath,
			);
		} catch (error) {
			recordError(context, entryPath, error);
		}
		files.push({
			path: entryPath,
			modified_at: modifiedAtSeconds(stat),
			size: Number(stat.size),
		});
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
		excludedEntries: [...(options.alwaysIgnoredDirectoryNames ?? [])],
		startedAtMs: Date.now(),
		stats: {
			visitedEntryCount: 0,
			visitedDirectoryCount: 0,
			ignoredDirectoryCount: 0,
			ignoredFileCount: 0,
			prunedNestedRepoCount: 0,
		},
		errors: [],
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
						context.excludedEntries,
					),
		errors: context.errors,
	};
}
