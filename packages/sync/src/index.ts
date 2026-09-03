export type { SyncBackend } from "./backend.js";
export {
	isInitialized,
	readConfig,
	readConfigOrDefault,
	readSyncState,
	removeCloudSyncConfig,
	writeCloudSyncConfig,
	writeConfig,
	writeSyncState,
} from "./config.js";
export type {
	FileSystem,
	InitFileSystem,
	LocalAsset,
	LocalFile,
} from "./fs.js";
export { contentHash } from "./fs.js";
export type { ExcludedTopInfo, SubtreeCount } from "./scope.js";
export {
	classifyExcludedTop,
	countSubtreeWithEarlyBail,
	hasGitMarker,
	isOverPendingThreshold,
	isUnchangedByStat,
	matchesExcludedPattern,
	normalizeExcludedEntries,
	PENDING_BAIL_COUNT,
	PENDING_DIR_THRESHOLD,
	PENDING_FILE_THRESHOLD,
} from "./scope.js";
export {
	createThrottledProgress,
	execute,
	init,
	plan,
	status,
	summarizePlanByFolder,
	sync,
} from "./sync.js";
export type {
	AuthorizedUrl,
	CloudSyncConfig,
	FileState,
	FolderAutoExcludeReason,
	FolderSummaryEntry,
	PendingFolder,
	PlannedDelete,
	PlannedPull,
	PlannedPush,
	RemoteAsset,
	RemoteFile,
	SyncPlan,
	SyncProgress,
	SyncProgressCallback,
	SyncResult,
	SyncState,
	WorkspaceConfig,
} from "./types.js";
export { PendingFolderSchema } from "./types.js";
