export {
	ALWAYS_IGNORED_WORKSPACE_DIRECTORY_NAMES,
	discoverWorkspaceFiles,
	isAlwaysIgnoredWorkspacePath,
	isExcludedByEntries,
	rootExtraIgnoreFiles,
	WorkspaceDirectoryLimitError,
	type WorkspaceDiscoveryError,
	type WorkspaceDiscoveryOptions,
	type WorkspaceDiscoveryResult,
	type WorkspaceDiscoveryStats,
	type WorkspaceFileEntry,
	type WorkspaceFolderEntry,
	type WorkspaceSymlinkInfo,
	WorkspaceTraversalLimitError,
} from "./file-discovery.js";
export { assetsWalker, MAX_ASSET_SIZE } from "./walkers/assetsWalker.js";
export { notesWalker } from "./walkers/notesWalker.js";
export { sidecarWalker } from "./walkers/sidecarWalker.js";
export type { WalkerErrorEntry, WalkerResult } from "./walkers/types.js";
