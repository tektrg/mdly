/**
 * Settings → Files: per-workspace "Files in scope" rules, persisted in
 * `.hubble/config.json` under `scope`, plus the global default list
 * (userData) that seeds workspaces without one. The rules themselves live
 * in `@mdly/workspace-scan`'s `files-scope.ts`; this module is the I/O.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
	appExcludedEntries,
	BUILT_IN_DEFAULT_FILES_SCOPE,
	BUILT_IN_HIDDEN_PATTERNS,
	discoverWorkspaceFiles,
	type FilesScope,
	type FilesScopeConfigSource,
	parseFilesScope,
	resolveWorkspaceFilesScope,
	SYNCED_NOTE_EXTENSION_RE,
	syncExcludedEntries,
	WorkspaceTraversalLimitError,
} from "@mdly/workspace-kit/file-discovery";
import {
	hasDocumentExtension,
	isHiddenSidebarFolderName,
} from "../src/lib/filePath";

const DEFAULTS_FILE_NAME = "files-scope-defaults.json";
/** Counting is a preview — bail rather than walk an unbounded tree. */
const COUNT_MAX_ENTRIES = 200_000;

let defaultsFilePath: string | null = null;
let savedDefaults: FilesScope | null = null;

export type WorkspaceFilesScopeState = {
	scope: FilesScope;
	/** False while the workspace still runs on the legacy list / global defaults (nothing written yet). */
	isCustomized: boolean;
	builtInPatterns: string[];
};

export type FilesScopeCounts = {
	/** Documents the app lists; null when the workspace is too large to count. */
	visible: number | null;
	/** Notes Cloud Sync would upload; null when too large to count. */
	synced: number | null;
};

export async function loadFilesScopeDefaults(
	userDataDir: string,
): Promise<void> {
	defaultsFilePath = path.join(userDataDir, DEFAULTS_FILE_NAME);
	try {
		savedDefaults = parseFilesScope(
			JSON.parse(await fs.readFile(defaultsFilePath, "utf8")),
		);
	} catch {
		savedDefaults = null;
	}
}

/**
 * The global default list. Before one is saved, the legacy global
 * "Show ignored files" pref decides `respectGitignore` (its migration).
 */
export function getFilesScopeDefaults(legacyShowIgnoredFiles = false) {
	return (
		savedDefaults ?? {
			...BUILT_IN_DEFAULT_FILES_SCOPE,
			respectGitignore: !legacyShowIgnoredFiles,
		}
	);
}

export async function saveFilesScopeDefaults(
	scope: unknown,
): Promise<FilesScope> {
	const parsed = parseFilesScope(scope);
	if (!parsed) throw new Error("Invalid Files settings.");
	if (!defaultsFilePath) throw new Error("Files defaults are not loaded yet.");
	await fs.writeFile(defaultsFilePath, `${JSON.stringify(parsed, null, 2)}\n`);
	savedDefaults = parsed;
	return parsed;
}

function workspaceConfigFilePath(workspaceRoot: string): string {
	return path.join(workspaceRoot, ".hubble", "config.json");
}

/** Reads the raw `.hubble/config.json` object without validating/stripping any key, so callers can preserve whatever they don't understand. */
export async function readRawWorkspaceConfigFile(
	workspaceRoot: string,
): Promise<Record<string, unknown>> {
	try {
		const parsed = JSON.parse(
			await fs.readFile(workspaceConfigFilePath(workspaceRoot), "utf8"),
		);
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

export async function readWorkspaceFilesScope(
	workspaceRoot: string,
	legacyShowIgnoredFiles = false,
): Promise<WorkspaceFilesScopeState> {
	const raw = await readRawWorkspaceConfigFile(workspaceRoot);
	return {
		scope: resolveWorkspaceFilesScope(
			raw as FilesScopeConfigSource,
			getFilesScopeDefaults(legacyShowIgnoredFiles),
		),
		isCustomized: parseFilesScope(raw.scope) !== null,
		builtInPatterns: [...BUILT_IN_HIDDEN_PATTERNS],
	};
}

/** Cloud Sync's effective exclusion entries for a parsed workspace config. */
export function effectiveSyncExcludedEntries(
	config: FilesScopeConfigSource | null | undefined,
): string[] {
	return syncExcludedEntries(
		resolveWorkspaceFilesScope(config, getFilesScopeDefaults()),
	);
}

/** Persists a workspace's scope. The legacy `cloudSync.excludedFolders` is dropped: `scope` supersedes it. */
export async function writeWorkspaceFilesScope(
	workspaceRoot: string,
	scope: unknown,
): Promise<FilesScope> {
	const parsed = parseFilesScope(scope);
	if (!parsed) throw new Error("Invalid Files settings.");
	const raw = await readRawWorkspaceConfigFile(workspaceRoot);
	const next: Record<string, unknown> = { ...raw, scope: parsed };
	if (typeof raw.cloudSync === "object" && raw.cloudSync !== null) {
		const { excludedFolders: _superseded, ...cloudSync } =
			raw.cloudSync as Record<string, unknown>;
		next.cloudSync = cloudSync;
	}
	const configPath = workspaceConfigFilePath(workspaceRoot);
	await fs.mkdir(path.dirname(configPath), { recursive: true });
	await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`);
	return parsed;
}

/**
 * For Cloud Sync's exclusion writers (large-folder "never sync", first-sync
 * review): when the workspace already has its own `scope`, apply the change
 * there and return true; otherwise return false so the caller keeps writing
 * the legacy list.
 */
export async function updateCustomizedFilesScope(
	workspaceRoot: string,
	update: (scope: FilesScope) => FilesScope,
): Promise<boolean> {
	const raw = await readRawWorkspaceConfigFile(workspaceRoot);
	const own = parseFilesScope(raw.scope);
	if (!own) return false;
	await writeWorkspaceFilesScope(workspaceRoot, update(own));
	return true;
}

/** Options for the sidebar/document-table/Cmd+P listing ("In app"). */
export function appListingOptions(scope: FilesScope) {
	return {
		includeIgnoredWorkspaceFiles: !scope.respectGitignore,
		excludedEntries: appExcludedEntries(scope),
	};
}

async function countOrNull(walk: () => Promise<number>) {
	try {
		return await walk();
	} catch (error) {
		if (error instanceof WorkspaceTraversalLimitError) return null;
		throw error;
	}
}

/** Live "N visible · M synced" for Settings, using the SAME rules the sidebar and sync walk use. */
export async function countFilesInScope(
	workspaceRoot: string,
	scope: FilesScope,
	pendingSyncFolders: readonly string[] = [],
): Promise<FilesScopeCounts> {
	const listing = appListingOptions(scope);
	const isVisibleFolderName = (name: string) =>
		!isHiddenSidebarFolderName(name);
	const [visible, synced] = await Promise.all([
		countOrNull(async () => {
			const result = await discoverWorkspaceFiles({
				workspaceRoot,
				isSupportedFile: hasDocumentExtension,
				isVisibleFolderName,
				includeIgnoredWorkspaceFiles: listing.includeIgnoredWorkspaceFiles,
				alwaysIgnoredDirectoryNames: listing.excludedEntries,
				maxEntries: COUNT_MAX_ENTRIES,
			});
			return result.files.length;
		}),
		countOrNull(async () => {
			const result = await discoverWorkspaceFiles({
				workspaceRoot,
				isSupportedFile: (candidate) =>
					SYNCED_NOTE_EXTENSION_RE.test(candidate),
				isVisibleFolderName,
				alwaysIgnoredDirectoryNames: [
					...syncExcludedEntries(scope),
					...pendingSyncFolders,
				],
				pruneNestedRepos: true,
				maxEntries: COUNT_MAX_ENTRIES,
			});
			return result.files.length;
		}),
	]);
	return { visible, synced };
}
