export type FileEntry = {
	path: string;
	modified_at: number;
	is_symlink?: boolean;
	symlink_target?: string | null;
	symlink_target_exists?: boolean;
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

export type WorkspaceConfig = {
	version: 1;
	pinnedNotes: string[];
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
	readWorkspaceConfig(workspacePath: string): Promise<WorkspaceConfig>;
	writeWorkspaceConfig(
		workspacePath: string,
		config: WorkspaceConfig,
	): Promise<void>;
	readFileText(path: string): Promise<string>;
	writeFileText(path: string, content: string): Promise<void>;
	renameFile(fromPath: string, toPath: string): Promise<void>;
	renameSymlinkTarget(linkPath: string, nextName: string): Promise<void>;
	pathExists(path: string): Promise<boolean>;
	persistPastedImage(
		input: PersistPastedImageInput,
	): Promise<PersistPastedImageOutput>;
	deleteFile(path: string, options?: { recursive?: boolean }): Promise<void>;
	readBinaryFile(path: string): Promise<number[]>;
	writeBinaryFile(path: string, bytes: number[]): Promise<void>;
	openFilePicker(options: { defaultPath?: string }): Promise<string | null>;
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
	onMenuShowWorkspaceSwitcher(callback: () => void): Unsubscribe;
	onMenuSyncWorkspace(callback: () => void): Unsubscribe;
	onWindowFocus(callback: () => void): Unsubscribe;
	onFullScreenChange(callback: (isFullScreen: boolean) => void): Unsubscribe;
};
