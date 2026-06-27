import { Command } from "cmdk";
import MingcuteRightLine from "~icons/mingcute/right-line";
import MingcuteTextLine from "~icons/mingcute/text-line";
import {
	commandScopeOptions,
	resolveFolderScope,
	resolveNotionScope,
	type CommandScopeKind,
	type FolderScopeOption,
} from "../lib/commandQuery";
import type { FileSearchResult } from "../lib/fileSearch";
import { cn } from "../lib/utils";
import type { WorkspaceChoice } from "../lib/workspaceChoices";
import type {
	NotionConnectionStatus,
	NotionSearchResult,
} from "../desktopApi/types";

type CommandBarContentInput = {
	accountChoices: string[];
	fileResults: FileSearchResult[];
	folderChoices: FolderScopeOption[];
	folderScope: ReturnType<typeof resolveFolderScope>;
	notionConnection: NotionConnectionStatus | null;
	notionError: string | null;
	notionResults: NotionSearchResult[];
	notionScope: ReturnType<typeof resolveNotionScope>;
	notionStatus: "idle" | "checking" | "searching" | "opening";
	onSelectAccount: (account: string) => void;
	onSelectFile: (path: string) => void;
	onSelectFolder: (folder: FolderScopeOption) => void;
	onSelectNotionResult: (result: NotionSearchResult) => void;
	onSelectWorkspace: (choice: WorkspaceChoice) => void;
	showingNotion: boolean;
	showingWorkspace: boolean;
	workspaceChoices: WorkspaceChoice[];
	workspaceError: string | null;
	workspaceStatus: "idle" | "switching";
};

export function renderCommandContent({
	accountChoices,
	fileResults,
	folderChoices,
	folderScope,
	notionConnection,
	notionError,
	notionResults,
	notionScope,
	notionStatus,
	onSelectAccount,
	onSelectFile,
	onSelectFolder,
	onSelectNotionResult,
	onSelectWorkspace,
	showingNotion,
	showingWorkspace,
	workspaceChoices,
	workspaceError,
	workspaceStatus,
}: CommandBarContentInput) {
	if (showingWorkspace) {
		return (
			<>
				<WorkspaceStatusRows error={workspaceError} status={workspaceStatus} />
				<Command.Group heading="Workspaces" className={groupClassName}>
					{workspaceChoices.map((choice) => (
						<WorkspaceCommandItem
							key={workspaceValue(choice)}
							choice={choice}
							onSelect={onSelectWorkspace}
						/>
					))}
				</Command.Group>
			</>
		);
	}

	if (folderScope.kind === "editing") {
		return (
			<Command.Group heading="Folders" className={groupClassName}>
				{folderChoices.map((folder) => (
					<FolderCommandItem
						key={folder.path}
						folder={folder}
						onSelect={onSelectFolder}
					/>
				))}
				{folderChoices.length === 0 ? (
					<Command.Empty className={emptyClassName}>No folders found</Command.Empty>
				) : null}
			</Command.Group>
		);
	}

	if (showingNotion) {
		return (
			<>
				<NotionStatusRows
					connection={notionConnection}
					error={notionError}
					scope={notionScope}
					status={notionStatus}
				/>
				{accountChoices.length > 0 ? (
					<Command.Group heading="Notion accounts" className={groupClassName}>
						{accountChoices.map((account) => (
							<AccountCommandItem
								key={account}
								account={account}
								onSelect={onSelectAccount}
							/>
						))}
					</Command.Group>
				) : null}
				{notionResults.length > 0 ? (
					<Command.Group heading="Notion" className={groupClassName}>
						{notionResults.map((result) => (
							<NotionCommandItem
								key={`${result.object}:${result.id}`}
								result={result}
								onSelect={onSelectNotionResult}
							/>
						))}
					</Command.Group>
				) : null}
			</>
		);
	}

	return (
		<Command.Group heading="Files" className={groupClassName}>
			{fileResults.map((result) => (
				<FileCommandItem
					key={result.path}
					result={result}
					onSelect={onSelectFile}
				/>
			))}
			{fileResults.length === 0 ? (
				<Command.Empty className={emptyClassName}>No Markdown files found</Command.Empty>
			) : null}
		</Command.Group>
	);
}

export function ScopeOptionPopover({
	options,
	selectedIndex,
	onSelect,
}: {
	options: typeof commandScopeOptions;
	selectedIndex: number;
	onSelect: (scope: CommandScopeKind) => void;
}) {
	return (
		<div className="absolute left-8 top-full z-10 mt-1 w-64 rounded-[var(--radius-popover)] border border-border bg-popover p-1 text-popover-foreground shadow-overlay">
			{options.map((option, index) => (
				<button
					key={option.kind}
					type="button"
					onMouseDown={(event) => {
						event.preventDefault();
						onSelect(option.kind);
					}}
					className={cn(
						"flex w-full items-start gap-2 rounded-[var(--radius-row)] px-2 py-1.5 text-left outline-hidden",
						index === selectedIndex && "bg-accent text-accent-foreground",
					)}
				>
					<span className="mt-0.5 text-xs text-muted-foreground">@</span>
					<span className="min-w-0">
						<span className="block text-[13px] leading-5">{option.label}</span>
						<span className="block text-[11px] leading-4 text-muted-foreground">
							{option.description}
						</span>
					</span>
				</button>
			))}
		</div>
	);
}

export function CommandFooter({
	folderScope,
	notionScope,
	showingNotion,
	showingWorkspace,
	workspaceStatus,
}: {
	folderScope: ReturnType<typeof resolveFolderScope>;
	notionScope: ReturnType<typeof resolveNotionScope>;
	showingNotion: boolean;
	showingWorkspace: boolean;
	workspaceStatus: "idle" | "switching";
}) {
	const label = showingWorkspace
		? workspaceStatus === "switching"
			? "Switching workspace…"
			: "Workspace · Recent folders"
		: showingNotion
			? notionScope.kind === "ready" && notionScope.account
				? `Notion · ${notionScope.account}`
				: "Notion"
			: folderScope.kind === "resolved"
				? `Folder · ${folderScope.folder.relativePath}`
				: "Markdown files";
	const action = showingWorkspace ? "switch" : "open";
	return (
		<div className="flex items-center justify-between border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
			<span className="truncate">{label}</span>
			<span className="flex items-center gap-1">
				<kbd className="rounded-[var(--radius-inner)] bg-muted px-1.5 py-0.5 leading-4">
					Enter
				</kbd>
				{action}
			</span>
		</div>
	);
}

function WorkspaceStatusRows({
	error,
	status,
}: {
	error: string | null;
	status: "idle" | "switching";
}) {
	const messages: string[] = [];
	if (status === "switching") messages.push("Switching workspace…");
	if (error) messages.push(error);
	if (messages.length === 0) return null;
	return (
		<div className="px-3 py-3 text-sm text-muted-foreground" aria-live="polite">
			{messages.map((message) => (
				<p key={message} className="m-0">
					{message}
				</p>
			))}
		</div>
	);
}

function NotionStatusRows({
	connection,
	error,
	scope,
	status,
}: {
	connection: NotionConnectionStatus | null;
	error: string | null;
	scope: ReturnType<typeof resolveNotionScope>;
	status: "idle" | "checking" | "searching" | "opening";
}) {
	const messages: string[] = [];
	if (status === "checking" && !connection) messages.push("Checking Notion");
	if (status === "searching") messages.push("Searching Notion");
	if (status === "opening") messages.push("Opening Notion page");
	if (connection && !connection.connected) messages.push("Notion is not connected");
	if (scope.kind === "needs-account") messages.push("Choose a Notion account");
	if (scope.kind === "invalid-account") messages.push("Unknown Notion account");
	if (scope.kind === "ready" && !scope.searchQuery.trim()) {
		messages.push("Type to search Notion");
	}
	if (error) messages.push(error);
	if (messages.length === 0) return null;
	return (
		<div className="px-3 py-3 text-sm text-muted-foreground">
			{messages.map((message) => (
				<p key={message} className="m-0">
					{message}
				</p>
			))}
		</div>
	);
}

function FileCommandItem({
	result,
	onSelect,
}: {
	result: FileSearchResult;
	onSelect: (path: string) => void;
}) {
	return (
		<Command.Item
			value={fileValue(result.path)}
			keywords={[result.label, result.relativePath]}
			onSelect={() => onSelect(result.path)}
			className={itemClassName}
		>
			<ItemIcon />
			<ItemText label={result.label} detail={result.directory || result.relativePath} />
			<MingcuteRightLine className="size-3.5 shrink-0 text-muted-foreground opacity-70" />
		</Command.Item>
	);
}

function FolderCommandItem({
	folder,
	onSelect,
}: {
	folder: FolderScopeOption;
	onSelect: (folder: FolderScopeOption) => void;
}) {
	return (
		<Command.Item
			value={folderValue(folder)}
			onSelect={() => onSelect(folder)}
			className={itemClassName}
		>
			<ItemIcon />
			<ItemText label={folder.label} detail={folder.relativePath} />
			<MingcuteRightLine className="size-3.5 shrink-0 text-muted-foreground opacity-70" />
		</Command.Item>
	);
}

function AccountCommandItem({
	account,
	onSelect,
}: {
	account: string;
	onSelect: (account: string) => void;
}) {
	return (
		<Command.Item
			value={accountValue(account)}
			onSelect={() => onSelect(account)}
			className={itemClassName}
		>
			<ItemIcon />
			<ItemText label={account} detail="Notion account" />
			<MingcuteRightLine className="size-3.5 shrink-0 text-muted-foreground opacity-70" />
		</Command.Item>
	);
}

function NotionCommandItem({
	result,
	onSelect,
}: {
	result: NotionSearchResult;
	onSelect: (result: NotionSearchResult) => void;
}) {
	return (
		<Command.Item
			value={notionValue(result)}
			keywords={[result.title, result.object, result.account ?? ""]}
			onSelect={() => onSelect(result)}
			className={itemClassName}
		>
			<ItemIcon />
			<ItemText
				label={result.title}
				detail={result.object === "page" ? "Page" : "Read-only table"}
			/>
			<MingcuteRightLine className="size-3.5 shrink-0 text-muted-foreground opacity-70" />
		</Command.Item>
	);
}

function WorkspaceCommandItem({
	choice,
	onSelect,
}: {
	choice: WorkspaceChoice;
	onSelect: (choice: WorkspaceChoice) => void;
}) {
	const detail =
		choice.kind === "workspace" && choice.current
			? `${choice.detail} · Current`
			: choice.detail;
	return (
		<Command.Item
			value={workspaceValue(choice)}
			keywords={[choice.label, choice.detail]}
			onSelect={() => onSelect(choice)}
			className={itemClassName}
		>
			<ItemIcon />
			<ItemText label={choice.label} detail={detail} />
			{choice.kind === "workspace" && choice.current ? (
				<span className="shrink-0 rounded-[var(--radius-inner)] bg-muted px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground">
					Current
				</span>
			) : (
				<MingcuteRightLine className="size-3.5 shrink-0 text-muted-foreground opacity-70" />
			)}
		</Command.Item>
	);
}

function ItemIcon() {
	return (
		<span className="flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-inner)] bg-background text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]">
			<MingcuteTextLine className="size-3.5" />
		</span>
	);
}

function ItemText({ label, detail }: { label: string; detail: string }) {
	return (
		<span className="min-w-0 flex-1">
			<span className="block truncate text-[13px] leading-5">{label}</span>
			<span className="block truncate text-[11px] leading-4 text-muted-foreground">
				{detail}
			</span>
		</span>
	);
}

export function fileValue(path: string) {
	return `file:${path}`;
}

export function folderValue(folder: FolderScopeOption) {
	return `folder:${folder.path}`;
}

export function accountValue(account: string) {
	return `account:${account}`;
}

export function notionValue(result: NotionSearchResult) {
	return `notion:${result.object}:${result.id}`;
}

export function workspaceValue(choice: WorkspaceChoice) {
	return choice.kind === "workspace"
		? `workspace:${choice.path}`
		: "workspace:add-folder";
}

const groupClassName =
	"[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:leading-4 [&_[cmdk-group-heading]]:text-muted-foreground";

const itemClassName = cn(
	"flex min-h-11 w-full items-center gap-2 rounded-[var(--radius-row)] px-2 text-start outline-hidden transition-[background-color,color] duration-150 ease-snappy",
	"data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
);

const emptyClassName = "px-3 py-8 text-center text-sm text-muted-foreground";
