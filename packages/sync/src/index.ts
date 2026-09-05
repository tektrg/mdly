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
export { mergeJsonlUnion } from "./sidecarMerge.js";
export type { ExecuteSidecarsDeps, PushChunk } from "./sync.js";
export {
	chunkPushOps,
	createThrottledProgress,
	execute,
	executeSidecars,
	init,
	isPermanentFailure,
	MAX_PUSH_BATCH_BYTES,
	MAX_PUSH_BATCH_FILES,
	MAX_PUSH_FILE_BYTES,
	plan,
	planSidecars,
	status,
	summarizePlanByFolder,
	sync,
} from "./sync.js";
export type {
	AuthorizedUrl,
	CloudSyncConfig,
	FailedFile,
	FileState,
	FolderAutoExcludeReason,
	FolderSummaryEntry,
	PendingFolder,
	PlannedDelete,
	PlannedPull,
	PlannedPush,
	PlannedSidecarMerge,
	RejectedFile,
	RemoteAsset,
	RemoteFile,
	SyncPlan,
	SyncProgress,
	SyncProgressCallback,
	SyncResult,
	SyncState,
	WorkspaceConfig,
} from "./types.js";
export { PendingFolderSchema, RejectedFileSchema } from "./types.js";
