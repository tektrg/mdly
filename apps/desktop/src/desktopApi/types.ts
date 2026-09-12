export type FileEntry = {
	path: string;
	modified_at: number;
	is_symlink?: boolean;
	symlink_target?: string | null;
	symlink_target_exists?: boolean;
	symlink_target_in_workspace?: boolean;
	symlink_canonical_path?: string | null;
};

export type FolderEntry = FileEntry;

export type DirectoryListing = {
	files: FileEntry[];
	folders: FolderEntry[];
};

export type DirectoryListingOptions = {
	includeIgnoredWorkspaceFiles?: boolean;
};

export type HtmlAppFileEntry = {
	name: string;
	path: string;
	modified_at: number;
	size: number;
};

export type PersistPastedImageInput = {
	filePath: string;
	bytes: number[];
	mimeType: string | null;
};

export type PersistPastedImageOutput = {
	relativeMarkdownPath: string;
	deduped: boolean;
};

export type WatchOptions = {
	recursive: boolean;
};

export type Unsubscribe = () => void;

export type MenuState = {
	hasWorkspace: boolean;
};

export type DesktopUpdateStatus =
	| "idle"
	| "checking"
	| "up-to-date"
	| "downloading"
	| "ready"
	| "error";

export type DesktopUpdateState = {
	isSupported: boolean;
	status: DesktopUpdateStatus;
	currentVersion: string;
	availableVersion: string | null;
	progressPercent: number | null;
	message: string | null;
	lastCheckedAt: number | null;
};

export type DesktopPlatform = NodeJS.Platform;

export type NotionObjectType = "page" | "database" | "data_source";

export type NotionSearchResult = {
	id: string;
	object: NotionObjectType;
	account: string | null;
	title: string;
	url: string | null;
	lastEditedTime: string | null;
};

export type NotionPageMarkdown = {
	pageId: string;
	account: string | null;
	markdown: string;
	contentHash: string;
};

export type NotionPageUpdate = {
	pageId: string;
	account: string | null;
	contentHash: string;
};

export type NotionPageUpdateOptions = {
	previousMarkdown?: string;
	currentMarkdown?: string;
};

export type NotionDatabaseQueryInput = {
	sourceId: string;
	sourceObject: Extract<NotionObjectType, "database" | "data_source">;
	account?: string | null;
	startCursor?: string | null;
	pageSize?: number;
};

export type NotionDatabaseRow = {
	pageId: string;
	title: string;
	url: string | null;
	lastEditedTime: string | null;
	properties: Record<string, string>;
};

export type NotionDatabaseQueryResult = {
	sourceId: string;
	columns: string[];
	rows: NotionDatabaseRow[];
	hasMore: boolean;
	nextCursor: string | null;
};

export type NotionConnectionStatus = {
	account: string;
	availableAccounts: string[];
	tokenKind: "oauth" | "api_key" | "missing";
	connected: boolean;
	botName: string | null;
	error: string | null;
};

export type DocImportResult = {
	markdown: string;
	contentHash: string;
	title: string;
	kind: string;
	converter: string;
	origin?: "url" | "file";
	url?: string | null;
	path?: string | null;
};

export type DocImportErrorKind =
	| "converter-missing"
	| "unreadable"
	| "scanned-pdf"
	| "unsupported-format"
	| "timeout"
	| "unknown";

export type ConverterStatus = {
	available: boolean;
	version: string | null;
	installHint: string;
};

export type WorkspaceConfig = {
	version: 1;
	pinnedNotes: string[];
};

/** Mirrors `apps/desktop/electron/cloudSyncWiring.ts`'s `CloudSyncStatus` (charter rules R19-R30). */
export type CloudSyncStatus =
	| "off"
	| "connecting"
	| "syncing"
	| "idle"
	| "error"
	| "needs-reauth"
	| "workspace-unavailable"
	| "workspace-too-large";

/** Mirrors `apps/desktop/electron/cloudSyncWiring.ts`'s `CloudSyncWorkspaceState`. */
export type CloudSyncWorkspaceState = {
	backgroundSync: boolean;
	status: CloudSyncStatus;
	workspaceId: string | null;
	deploymentUrl: string | null;
	detail: string | null;
	/** The EFFECTIVE never-synced exclusion list (bare names match at any depth; entries with a separator are anchored to the workspace root). */
	excludedFolders: string[];
	/** Folders held out of sync until approved (D-LW5). Empty when none pending. */
	pendingFolders: PendingFolder[];
	/** Latest structured sync progress, if a sync is or recently was running. */
	progress: SyncProgress | null;
};

/** A folder held out of sync until the user approves it. */
export type PendingFolder = {
	path: string;
	fileCountAtLeast: number;
	dirCountAtLeast?: number;
	discoveredAt: number;
};

/** Structured sync progress — `scan` is indeterminate (no total until the walk ends). */
export type SyncProgress = {
	phase: "scan" | "push" | "pull" | "assets" | "done";
	done: number;
	total: number | null;
	currentPath?: string;
};

/** Per-folder roll-up of a sync plan for the first-sync review dialog. */
export type SyncFolderSummary = {
	folder: string;
	fileCount: number;
	bytes: number;
	autoExcluded?: "gitignored" | "nested-repo" | "over-threshold";
};

/** Dry-run preview: the SAME plan the real sync will execute, plus greyed excluded rows with engine-emitted reasons. */
export type SyncPreview = {
	folders: SyncFolderSummary[];
	totalOps: number;
	toPush: number;
	toPull: number;
	conflicts: number;
};

/** Inputs the review dialog passes to prepare its plan-backed preview (password stored in the Keychain, remote record ensured, nothing started). */
export type PrepareSyncPreviewOptions = {
	workspaceName: string;
	deploymentUrl: string;
	password?: string;
};

export type EnableCloudSyncOptions = {
	workspaceName: string;
	deploymentUrl: string;
	/** The shared Cloud Sync password (R20). Required only the first time, or to rotate it; omit to reuse whatever is already in the Keychain. */
	password?: string;
	/** Folders the first-sync review dialog left unchecked — the initial exclusion list instead of the defaults. */
	excludedFolders?: string[];
};

/** First-sync review preview is always plan-backed (prepare step); no local-only estimator exists by design. */

/**
 * Tags an in-app save so `@mdly/doc-history` can cut a version alongside the
 * real write. Undefined by default so ordinary writes are unaffected.
 * `'external-write'` is deliberately excluded — that cause is reserved for
 * the active-file watcher hook.
 */
export type InAppHistoryCause =
	| "idle-session"
	| "manual"
	| "import"
	| "restore";

export type WriteFileTextOptions = {
	historyCause?: InAppHistoryCause;
};

export type HistoryRevisionAuthorKind = "human" | "agent" | "external";

export type HistoryRevisionAuthor = {
	kind: HistoryRevisionAuthorKind;
	id: string;
	label?: string;
};

/** Mirrors `@mdly/doc-history`'s `RevisionCause` (kept as a local literal union, matching this file's existing `InAppHistoryCause` convention, rather than importing the package into the renderer-facing IPC contract). */
export type HistoryRevisionCause =
	| "external-write"
	| "idle-session"
	| "manual"
	| "import"
	| "restore";

/** Mirrors `@mdly/doc-history`'s `Revision` shape (the "public, 7-field revision shape"). */
export type HistoryRevision = {
	id: string;
	hash: string;
	at: number;
	by: HistoryRevisionAuthor;
	cause: HistoryRevisionCause;
	bytes: number;
	prev: string | null;
};

export type ReadRevisionContentResult =
	| { status: "ok"; content: string }
	| { status: "unavailable" }
	| { status: "not-found" };

/** Mirrors `@mdly/workspace-kit`'s `CommentAuthor` (itself a local mirror of `@mdly/doc-comments`'s `CommentAuthor`, which is `HistoryRevisionAuthor`'s shape under a different name -- same kind/id/label triple). */
export type CommentAuthor = HistoryRevisionAuthor;

/** Mirrors `@mdly/workspace-kit`'s `TextAnchor` (rendered-text-space comment anchor). */
export type CommentTextAnchor = {
	from: number;
	to: number;
	quote: string;
	mode: "revision" | "quote";
	revisionId?: string;
	contextBefore?: string;
	contextAfter?: string;
};

export type CommentThreadEventKind =
	| "thread-opened"
	| "replied"
	| "resolved"
	| "reopened"
	| "deleted";

/** Mirrors `@mdly/workspace-kit`'s `CommentThreadEvent`. */
export type CommentThreadEvent = {
	id: string;
	kind: CommentThreadEventKind;
	by: CommentAuthor;
	text?: string;
	prev: string | null;
};

/** Mirrors `@mdly/workspace-kit`'s `CommentThread`. */
export type CommentThread = {
	id: string;
	opener: {
		id: string;
		by: CommentAuthor;
		anchor: CommentTextAnchor;
		text: string;
	};
	events: CommentThreadEvent[];
	state: "open" | "resolved" | "deleted";
};

/**
 * `desktop:comment-list-threads` folds `docId` resolution and the current
 * user's stable author identity into this response rather than exposing two
 * more IPC channels -- both are needed by the renderer before it can build a
 * `CommentOptions` object (its `docId`/`currentAuthor` fields aren't
 * promises).
 */
export type CommentThreadListResult = {
	docId: string;
	currentAuthor: CommentAuthor;
	threads: CommentThread[];
};

/**
 * Slice 4 (agent access to comments). These mirror
 * `electron/agentToolContract.ts` -- the main process is the single source of
 * truth for the tool table, and the renderer only republishes it to WebMCP, so
 * these types exist to type that pass-through and must stay structurally
 * identical to the contract's.
 */
export type AgentToolAnnotations = {
	readOnlyHint?: boolean;
	/** Mandatory on anything returning comment or document text -- that text is model-read and is a prompt-injection vector by construction. */
	untrustedContentHint?: boolean;
};

export type AgentToolDescriptor = {
	name: string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
		additionalProperties?: boolean;
	};
	annotations: AgentToolAnnotations;
};

export type AgentToolResult = {
	content: Array<{ type: "text"; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
};

/**
 * `connectCommand` is the ready-to-paste `claude mcp add ...` line for the
 * loopback MCP server, folded in here so Settings never has to assemble a URL
 * and a bearer token itself. Null whenever the server is not listening.
 */
export type AgentAccessState = {
	enabled: boolean;
	mcpUrl: string | null;
	connectCommand: string | null;
};

export type DesktopApi = {
	platform: DesktopPlatform;
	homeDir: string;
	listDirectory(
		path: string,
		options?: DirectoryListingOptions,
	): Promise<DirectoryListing>;
	listHtmlAppFiles(
		workspacePath: string,
		glob: string,
	): Promise<HtmlAppFileEntry[]>;
	/**
	 * Maps each path to the tags in its front matter, omitting files with none.
	 * Reads only the head of each file; workspace discovery itself never opens
	 * files, so this is a separate, on-demand step (see ADR-0008).
	 */
	scanFrontMatterTags(paths: string[]): Promise<Record<string, string[]>>;
	readWorkspaceConfig(workspacePath: string): Promise<WorkspaceConfig>;
	writeWorkspaceConfig(
		workspacePath: string,
		config: WorkspaceConfig,
	): Promise<void>;
	/** Read-only: never starts or stops a watcher/subscription (R27, R29). */
	getCloudSyncState(workspacePath: string): Promise<CloudSyncWorkspaceState>;
	/** Turns Cloud Sync on for this workspace (R26/R27's opt-in half, R28). */
	enableCloudSync(
		workspacePath: string,
		options: EnableCloudSyncOptions,
	): Promise<CloudSyncWorkspaceState>;
	/** Turns Cloud Sync off for this workspace (R27) — never touches another workspace's config (R26). */
	/**
	 * Turns cloud sync off AND deletes this workspace's cloud copy (R36).
	 * `cloudCopyDeleted` is false when the delete could not be performed
	 * (offline, rotated password) -- the local switch is still off, but the
	 * copy is still in the cloud and a retry is pending, so the UI must not
	 * report it as removed.
	 */
	disableCloudSync(
		workspacePath: string,
	): Promise<{ cloudCopyDeleted: boolean }>;
	/**
	 * Replaces this workspace's never-synced exclusion list and restarts a
	 * running watcher so it takes effect at once. Bare names match at any
	 * depth; entries with a separator are anchored to the workspace root.
	 */
	setCloudSyncExcludedFolders(
		workspacePath: string,
		folders: string[],
	): Promise<CloudSyncWorkspaceState>;
	/** First-sync review preview — prepares (password, remote record, dormant config) then returns the SAME plan the real sync will execute. */
	getCloudSyncPreview(
		workspacePath: string,
		options: PrepareSyncPreviewOptions,
	): Promise<SyncPreview>;
	/** Approves a pending folder: it syncs from now on. */
	approveCloudSyncPendingFolder(
		workspacePath: string,
		folderPath: string,
	): Promise<CloudSyncWorkspaceState>;
	/** Excludes a pending folder forever ("never ask again"). */
	excludeCloudSyncPendingFolder(
		workspacePath: string,
		folderPath: string,
	): Promise<CloudSyncWorkspaceState>;
	/** Live status updates for the D5 settings switch / status indicator (R29, R30), independent per workspace. Carries no counts — use onCloudSyncProgressChange for those. */
	onCloudSyncStatusChange(
		workspacePath: string,
		callback: (status: CloudSyncStatus, detail: string | null) => void,
	): Promise<Unsubscribe>;
	/** Live structured sync progress (indeterminate scan count-up, then a determinate bar). */
	onCloudSyncProgressChange(
		workspacePath: string,
		callback: (progress: SyncProgress) => void,
	): Promise<Unsubscribe>;
	readFileText(path: string): Promise<string>;
	writeFileText(
		path: string,
		content: string,
		options?: WriteFileTextOptions,
	): Promise<void>;
	renameFile(fromPath: string, toPath: string): Promise<void>;
	renameSymlinkTarget(linkPath: string, nextName: string): Promise<void>;
	/** Read-only: never appends to the note's history log (R19). Returned oldest-first, in the log's own reconstructed `prev`-chain edit order — never re-sorted by `at` (R9); the UI reverses for its newest-first display (R8). */
	getRevisionHistory(path: string): Promise<HistoryRevision[]>;
	/** Read-only: never appends to the note's history log (R19). */
	readRevisionContent(
		path: string,
		revisionId: string,
	): Promise<ReadRevisionContentResult>;
	/** Read-only: never appends to the comment log. */
	listCommentThreads(path: string): Promise<CommentThreadListResult>;
	openCommentThread(
		path: string,
		anchor: CommentTextAnchor,
		text: string,
	): Promise<void>;
	replyToCommentThread(
		path: string,
		threadId: string,
		text: string,
	): Promise<void>;
	resolveCommentThread(path: string, threadId: string): Promise<void>;
	reopenCommentThread(path: string, threadId: string): Promise<void>;
	deleteCommentThread(path: string, threadId: string): Promise<void>;
	/** Slice 4: the agent tool table, defined once in the main process and republished by the WebMCP bridge. */
	listAgentTools(): Promise<AgentToolDescriptor[]>;
	callAgentTool(
		name: string,
		input: Record<string, unknown>,
	): Promise<AgentToolResult>;
	getAgentAccessState(): Promise<AgentAccessState>;
	setAgentAccessEnabled(enabled: boolean): Promise<AgentAccessState>;
	/** Tells the main process which note is open, so an agent tool can default its `path` to it and every read can report where the user's attention is. */
	setOpenDocumentPath(path: string | null): Promise<void>;
	pathExists(path: string): Promise<boolean>;
	persistPastedImage(
		input: PersistPastedImageInput,
	): Promise<PersistPastedImageOutput>;
	deleteFile(path: string, options?: { recursive?: boolean }): Promise<void>;
	readBinaryFile(path: string): Promise<number[]>;
	writeBinaryFile(path: string, bytes: number[]): Promise<void>;
	openFilePicker(options: {
		defaultPath?: string;
		filters?: { name: string; extensions: string[] }[];
	}): Promise<string | null>;
	openFolderPicker(): Promise<string | null>;
	createFolderPicker(): Promise<string | null>;
	saveMarkdownFilePicker(options: {
		defaultPath?: string;
	}): Promise<string | null>;
	watchPath(
		path: string,
		options: WatchOptions,
		callback: (paths: string[]) => void,
	): Promise<Unsubscribe>;
	openExternalUrl(url: string): Promise<void>;
	revealFile(path: string): Promise<void>;
	resolvePath(path: string): Promise<string>;
	realPath(path: string): Promise<string>;
	toAssetUrl(path: string): string;
	getLaunchFilePath(): Promise<string | null>;
	getLaunchWorkspacePath(): Promise<string | null>;
	setMenuState(state: MenuState): Promise<void>;
	getUpdateState(): Promise<DesktopUpdateState>;
	getFullScreen(): Promise<boolean>;
	getNotionConnectionStatus(
		account?: string | null,
	): Promise<NotionConnectionStatus>;
	setNotionAccount(account: string): Promise<NotionConnectionStatus>;
	searchNotion(
		query: string,
		account?: string | null,
	): Promise<NotionSearchResult[]>;
	getNotionPageMarkdown(
		pageId: string,
		account?: string | null,
	): Promise<NotionPageMarkdown>;
	updateNotionPageMarkdown(
		pageId: string,
		markdown: string,
		account?: string | null,
		options?: NotionPageUpdateOptions,
	): Promise<NotionPageUpdate>;
	queryNotionDatabase(
		input: NotionDatabaseQueryInput,
	): Promise<NotionDatabaseQueryResult>;
	docImportConvert(filePath: string): Promise<DocImportResult>;
	docImportConvertUrl(url: string): Promise<DocImportResult>;
	docImportRetainSource(
		sourcePath: string,
		markdownFilePath: string,
		keep: boolean,
	): Promise<string | null>;
	docImportCheckConverter(): Promise<ConverterStatus>;
	checkForUpdates(): Promise<void>;
	installUpdate(): Promise<void>;
	onOpenFile(callback: (path: string) => void): Unsubscribe;
	onUpdateStateChange(
		callback: (state: DesktopUpdateState) => void,
	): Unsubscribe;
	onMenuCreateMarkdownFile(callback: () => void): Unsubscribe;
	onMenuOpenFile(callback: () => void): Unsubscribe;
	onMenuOpenFolder(callback: () => void): Unsubscribe;
	onMenuOpenSettings(callback: () => void): Unsubscribe;
	onMenuImportDocument(callback: () => void): Unsubscribe;
	onMenuShowWorkspaceSwitcher(callback: () => void): Unsubscribe;
	onMenuSyncWorkspace(callback: () => void): Unsubscribe;
	onWindowFocus(callback: () => void): Unsubscribe;
	onFullScreenChange(callback: (isFullScreen: boolean) => void): Unsubscribe;
	/** Slice 4: fires after an agent writes a comment, so the open editor refetches its threads live instead of on next load. */
	onCommentsChanged(callback: (path: string) => void): Unsubscribe;
};
