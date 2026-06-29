import { Dialog } from "@base-ui/react/dialog";
import { Command } from "cmdk";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import MingcuteSearchLine from "~icons/mingcute/search-line";
import { desktopApi } from "../desktopApi";
import type {
	NotionConnectionStatus,
	NotionSearchResult,
} from "../desktopApi/types";
import {
	type CommandScopeKind,
	commandScopeOptions,
	type FolderScopeOption,
	findScopeTrigger,
	insertScopeToken,
	resolveFolderScope,
	resolveNotionScope,
	resolveWorkspaceScope,
} from "../lib/commandQuery";
import { basename, relativeWorkspacePath } from "../lib/filePath";
import { searchWorkspaceFiles } from "../lib/fileSearch";
import { cn } from "../lib/utils";
import {
	buildWorkspaceChoices,
	type WorkspaceChoice,
} from "../lib/workspaceChoices";
import { EDITOR_INPUT_SELECTOR } from "../selectors";
import type { FileEntry, FolderEntry } from "../store/state";
import {
	accountValue,
	type CommandBarMode,
	CommandFooter,
	fileValue,
	folderValue,
	notionValue,
	renderCommandContent,
	ScopeOptionPopover,
	workspaceValue,
} from "./CommandBarItems";

type CommandBarProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	files: FileEntry[];
	folders: FolderEntry[];
	workspacePath: string | null;
	recentWorkspaces: string[];
	currentPath: string | null;
	moveSourcePath: string | null;
	onOpenFile: (path: string) => void;
	onOpenWorkspace: (path?: string) => Promise<boolean>;
	onOpenNotionResult: (result: NotionSearchResult) => Promise<void>;
	onMoveFileToFolder: (
		sourcePath: string,
		targetFolderPath: string,
		targetWorkspacePath: string,
	) => Promise<boolean>;
	onRequestMoveCurrentFile: () => void;
};

const notionSearchDebounceMs = 300;

export function CommandBar({
	open,
	onOpenChange,
	files,
	folders,
	workspacePath,
	recentWorkspaces,
	currentPath,
	moveSourcePath,
	onOpenFile,
	onOpenWorkspace,
	onOpenNotionResult,
	onMoveFileToFolder,
	onRequestMoveCurrentFile,
}: CommandBarProps) {
	const commandMode: CommandBarMode = moveSourcePath ? "move-file" : "open";
	const [query, setQuery] = useState("");
	const [selectedValue, setSelectedValue] = useState("");
	const [scopeOptionIndex, setScopeOptionIndex] = useState(0);
	const [moveWorkspacePath, setMoveWorkspacePath] = useState<string | null>(
		null,
	);
	const [moveWorkspaceFiles, setMoveWorkspaceFiles] = useState<FileEntry[]>([]);
	const [moveWorkspaceFolders, setMoveWorkspaceFolders] = useState<
		FolderEntry[]
	>([]);
	const [moveWorkspaceStatus, setMoveWorkspaceStatus] = useState<
		"idle" | "loading" | "ready" | "error"
	>("idle");
	const [moveStatus, setMoveStatus] = useState<"idle" | "moving">("idle");
	const [moveError, setMoveError] = useState<string | null>(null);
	const [notionConnection, setNotionConnection] =
		useState<NotionConnectionStatus | null>(null);
	const [notionResults, setNotionResults] = useState<NotionSearchResult[]>([]);
	const [notionStatus, setNotionStatus] = useState<
		"idle" | "checking" | "searching" | "opening"
	>("idle");
	const [notionError, setNotionError] = useState<string | null>(null);
	const [workspaceStatus, setWorkspaceStatus] = useState<"idle" | "switching">(
		"idle",
	);
	const [workspaceError, setWorkspaceError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	const scopedMoveWorkspacePath = moveWorkspacePath ?? workspacePath;
	const useScopedMoveListing =
		commandMode === "move-file" &&
		moveWorkspacePath !== null &&
		workspacePath !== null &&
		moveWorkspacePath.toLocaleLowerCase() !== workspacePath.toLocaleLowerCase();
	const commandFolderOptions = useMemo(
		() => buildFolderScopeOptions({ files, folders, workspacePath }),
		[files, folders, workspacePath],
	);
	const moveFolderOptions = useMemo(
		() =>
			buildFolderScopeOptions({
				files: useScopedMoveListing ? moveWorkspaceFiles : files,
				folders: useScopedMoveListing ? moveWorkspaceFolders : folders,
				workspacePath: scopedMoveWorkspacePath,
			}),
		[
			files,
			folders,
			moveWorkspaceFiles,
			moveWorkspaceFolders,
			scopedMoveWorkspacePath,
			useScopedMoveListing,
		],
	);
	const folderOptions =
		commandMode === "move-file" ? moveFolderOptions : commandFolderOptions;
	const moveIsLoadingFolders =
		commandMode === "move-file" &&
		useScopedMoveListing &&
		moveWorkspaceStatus === "loading";
	const scopeTrigger = useMemo(() => findScopeTrigger(query), [query]);
	const scopeOptions = useMemo(
		() =>
			scopeTrigger
				? commandScopeOptions.filter(
						(option) =>
							(commandMode === "open" || option.kind === "workspace") &&
							option.kind.startsWith(scopeTrigger.filter),
					)
				: [],
		[commandMode, scopeTrigger],
	);
	const folderScope = useMemo(
		() => resolveFolderScope(query, folderOptions),
		[folderOptions, query],
	);
	const notionScope = useMemo(
		() => resolveNotionScope(query, notionConnection?.availableAccounts ?? []),
		[notionConnection?.availableAccounts, query],
	);
	const notionConnectionMatchesScope =
		notionScope.kind !== "ready" ||
		!notionScope.account ||
		notionConnection?.account === notionScope.account;
	const workspaceScope = useMemo(() => resolveWorkspaceScope(query), [query]);
	const showingWorkspace = workspaceScope.kind !== "none";
	const showingNotion =
		commandMode === "open" && !showingWorkspace && notionScope.kind !== "none";
	const workspaceChoices = useMemo(
		() =>
			showingWorkspace
				? buildWorkspaceChoices({
						workspacePath,
						recentWorkspaces,
						query: workspaceScope.searchQuery,
					})
				: [],
		[recentWorkspaces, showingWorkspace, workspacePath, workspaceScope],
	);
	const folderChoices = useMemo(() => {
		if (showingWorkspace) return [];
		if (commandMode === "move-file") {
			return filterFolderOptions(
				folderOptions,
				folderScope.kind === "editing"
					? folderScope.input
					: folderScope.searchQuery,
			);
		}
		return folderScope.kind === "editing"
			? filterFolderOptions(folderOptions, folderScope.input)
			: [];
	}, [commandMode, folderOptions, folderScope, showingWorkspace]);
	const accountChoices =
		notionScope.kind === "needs-account" ||
		notionScope.kind === "invalid-account"
			? filterAccounts(notionScope.accounts, notionScope.input)
			: [];
	const fileResults = useMemo(
		() =>
			showingWorkspace ||
			showingNotion ||
			folderScope.kind === "editing" ||
			commandMode === "move-file"
				? []
				: searchWorkspaceFiles({
						files,
						workspacePath,
						query: folderScope.searchQuery,
						currentPath,
						folderPath:
							folderScope.kind === "resolved" ? folderScope.folder.path : null,
					}),
		[
			commandMode,
			currentPath,
			files,
			folderScope,
			showingNotion,
			showingWorkspace,
			workspacePath,
		],
	);
	const moveSourceLabel = moveSourcePath ? basename(moveSourcePath) : null;
	const openModeMoveLabel = currentPath ? basename(currentPath) : null;
	const visibleValues = useMemo(
		() => [
			...workspaceChoices.map(workspaceValue),
			...folderChoices.map((folder) => folderValue(folder)),
			...accountChoices.map((account) => accountValue(account)),
			...(commandMode === "open" && currentPath
				? ["action:move-current-file"]
				: []),
			...fileResults.map((result) => fileValue(result.path)),
			...notionResults.map(notionValue),
		],
		[
			accountChoices,
			commandMode,
			currentPath,
			fileResults,
			folderChoices,
			notionResults,
			workspaceChoices,
		],
	);

	const closeCommandBar = useCallback(() => {
		inputRef.current?.blur();
		onOpenChange(false);
		requestAnimationFrame(() => {
			document.querySelector<HTMLElement>(EDITOR_INPUT_SELECTOR)?.focus();
		});
	}, [onOpenChange]);

	const handleOpenChange = useCallback(
		(nextOpen: boolean) => {
			if (nextOpen) {
				onOpenChange(true);
				return;
			}
			if (workspaceStatus === "switching" || moveStatus === "moving") return;
			closeCommandBar();
		},
		[closeCommandBar, moveStatus, onOpenChange, workspaceStatus],
	);

	useEffect(() => {
		if (scopeOptionIndex < scopeOptions.length) return;
		setScopeOptionIndex(Math.max(scopeOptions.length - 1, 0));
	}, [scopeOptionIndex, scopeOptions.length]);

	useEffect(() => {
		if (open) {
			setQuery("");
			setSelectedValue("");
			setScopeOptionIndex(0);
			setMoveWorkspacePath(null);
			setMoveWorkspaceFiles([]);
			setMoveWorkspaceFolders([]);
			setMoveWorkspaceStatus("idle");
			setMoveStatus("idle");
			setMoveError(null);
			setWorkspaceStatus("idle");
			setWorkspaceError(null);
			requestAnimationFrame(() => inputRef.current?.focus());
			return;
		}
		if (document.activeElement === inputRef.current) inputRef.current?.blur();
		setNotionResults([]);
		setNotionError(null);
		setNotionStatus("idle");
		setMoveWorkspaceStatus("idle");
		setMoveStatus("idle");
		setMoveError(null);
		setWorkspaceStatus("idle");
		setWorkspaceError(null);
	}, [open]);

	useEffect(() => {
		if (
			!open ||
			commandMode !== "move-file" ||
			!moveWorkspacePath ||
			!useScopedMoveListing
		) {
			return;
		}

		let active = true;
		setMoveWorkspaceStatus("loading");
		setMoveWorkspaceFiles([]);
		setMoveWorkspaceFolders([]);
		setMoveError(null);
		desktopApi
			.listDirectory(moveWorkspacePath)
			.then((listing) => {
				if (!active) return;
				setMoveWorkspaceFiles(listing.files);
				setMoveWorkspaceFolders(listing.folders);
				setMoveWorkspaceStatus("ready");
			})
			.catch((error) => {
				if (!active) return;
				setMoveWorkspaceFiles([]);
				setMoveWorkspaceFolders([]);
				setMoveWorkspaceStatus("error");
				setMoveError(error instanceof Error ? error.message : String(error));
			});
		return () => {
			active = false;
		};
	}, [commandMode, moveWorkspacePath, open, useScopedMoveListing]);

	useEffect(() => {
		if (!open || commandMode !== "open") return;
		let active = true;
		setNotionStatus("checking");
		desktopApi
			.getNotionConnectionStatus()
			.then((connection) => {
				if (!active) return;
				setNotionConnection(connection);
				setNotionError(connection.error);
			})
			.catch((error) => {
				if (!active) return;
				setNotionConnection(null);
				setNotionError(error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				if (active) setNotionStatus("idle");
			});
		return () => {
			active = false;
		};
	}, [commandMode, open]);

	useEffect(() => {
		if (
			!open ||
			commandMode !== "open" ||
			notionScope.kind !== "ready" ||
			!notionScope.account ||
			notionConnection?.account === notionScope.account
		) {
			return;
		}

		let active = true;
		setNotionStatus("checking");
		setNotionConnection((current) =>
			current?.account === notionScope.account ? current : null,
		);
		desktopApi
			.getNotionConnectionStatus(notionScope.account)
			.then((connection) => {
				if (!active) return;
				setNotionConnection(connection);
				setNotionError(connection.error);
			})
			.catch((error) => {
				if (!active) return;
				setNotionError(error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				if (active) setNotionStatus("idle");
			});
		return () => {
			active = false;
		};
	}, [commandMode, notionConnection?.account, notionScope, open]);

	useEffect(() => {
		if (visibleValues.length === 0) {
			setSelectedValue("");
			return;
		}
		if (visibleValues.includes(selectedValue)) return;
		setSelectedValue(visibleValues[0]);
	}, [selectedValue, visibleValues]);

	useEffect(() => {
		if (
			!open ||
			commandMode !== "open" ||
			notionScope.kind !== "ready" ||
			!notionConnection?.connected ||
			!notionConnectionMatchesScope ||
			!notionScope.searchQuery.trim()
		) {
			setNotionResults([]);
			return;
		}

		let active = true;
		const timer = setTimeout(() => {
			setNotionStatus("searching");
			setNotionError(null);
			desktopApi
				.searchNotion(notionScope.searchQuery, notionScope.account)
				.then((results) => {
					if (active) setNotionResults(results);
				})
				.catch((error) => {
					if (!active) return;
					setNotionResults([]);
					setNotionError(
						error instanceof Error ? error.message : String(error),
					);
				})
				.finally(() => {
					if (active) setNotionStatus("idle");
				});
		}, notionSearchDebounceMs);

		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [
		notionConnection?.connected,
		notionConnectionMatchesScope,
		notionScope,
		commandMode,
		open,
	]);

	const selectScope = (scope: CommandScopeKind) => {
		setQuery(insertScopeToken(query, scopeTrigger, scope));
		setScopeOptionIndex(0);
		requestAnimationFrame(() => inputRef.current?.focus());
	};

	const selectFolder = (folder: FolderScopeOption) => {
		if (commandMode === "move-file") {
			void selectMoveFolder(folder);
			return;
		}
		setQuery(replaceFolderScope(query, folder));
		requestAnimationFrame(() => inputRef.current?.focus());
	};

	const selectMoveFolder = async (folder: FolderScopeOption) => {
		if (!moveSourcePath || !scopedMoveWorkspacePath) return;
		if (moveStatus === "moving") return;
		if (moveIsLoadingFolders) return;
		setMoveStatus("moving");
		setMoveError(null);
		try {
			const moved = await onMoveFileToFolder(
				moveSourcePath,
				folder.path,
				scopedMoveWorkspacePath,
			);
			if (moved) closeCommandBar();
		} catch (error) {
			setMoveError(error instanceof Error ? error.message : String(error));
		} finally {
			setMoveStatus("idle");
		}
	};

	const selectAccount = (account: string) => {
		setQuery(replaceNotionAccount(query, account));
		requestAnimationFrame(() => inputRef.current?.focus());
	};

	const selectPath = (path: string) => {
		if (!path) return;
		onOpenFile(path);
		closeCommandBar();
	};

	const startMoveCurrentFile = () => {
		setQuery("");
		setSelectedValue("");
		setScopeOptionIndex(0);
		setMoveError(null);
		onRequestMoveCurrentFile();
	};

	const selectNotionResult = async (result: NotionSearchResult) => {
		setNotionStatus("opening");
		setNotionError(null);
		try {
			await onOpenNotionResult(result);
			closeCommandBar();
		} catch (error) {
			setNotionError(error instanceof Error ? error.message : String(error));
		} finally {
			setNotionStatus("idle");
		}
	};

	const selectWorkspace = async (choice: WorkspaceChoice) => {
		if (commandMode === "move-file") {
			if (choice.kind === "add-folder") {
				const selected = await desktopApi.openFolderPicker();
				if (typeof selected === "string") {
					setMoveWorkspacePath(selected);
					setMoveWorkspaceStatus("loading");
					setQuery("");
				}
				requestAnimationFrame(() => inputRef.current?.focus());
				return;
			}
			setMoveWorkspacePath(choice.current ? null : choice.path);
			setMoveWorkspaceStatus(choice.current ? "idle" : "loading");
			setQuery("");
			requestAnimationFrame(() => inputRef.current?.focus());
			return;
		}
		if (workspaceStatus === "switching") return;
		if (choice.kind === "workspace" && choice.current) {
			closeCommandBar();
			return;
		}
		setWorkspaceStatus("switching");
		setWorkspaceError(null);
		try {
			const switched = await onOpenWorkspace(
				choice.kind === "workspace" ? choice.path : undefined,
			);
			if (switched) closeCommandBar();
		} catch (error) {
			setWorkspaceError(error instanceof Error ? error.message : String(error));
		} finally {
			setWorkspaceStatus("idle");
		}
	};

	const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (scopeOptions.length > 0) {
			if (event.key === "Tab") {
				event.preventDefault();
				selectScope(
					scopeOptions[scopeOptionIndex]?.kind ?? scopeOptions[0].kind,
				);
				return;
			}
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setScopeOptionIndex((index) => (index + 1) % scopeOptions.length);
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				setScopeOptionIndex(
					(index) => (index - 1 + scopeOptions.length) % scopeOptions.length,
				);
				return;
			}
			if (event.key === "Enter") {
				event.preventDefault();
				selectScope(
					scopeOptions[scopeOptionIndex]?.kind ?? scopeOptions[0].kind,
				);
				return;
			}
		}
		if (
			event.key === "Escape" &&
			workspaceStatus !== "switching" &&
			moveStatus !== "moving"
		) {
			event.preventDefault();
			closeCommandBar();
		}
	};

	return (
		<Dialog.Root open={open} onOpenChange={handleOpenChange}>
			<Dialog.Portal>
				<Dialog.Backdrop className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[1px] opacity-100 transition-opacity duration-150 ease-snappy data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none" />
				<Dialog.Popup
					className={cn(
						"fixed left-1/2 z-50 flex max-h-[min(28rem,calc(100dvh-4rem))] w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-[calc(var(--radius-popover)+0.25rem)] bg-popover p-1 text-popover-foreground shadow-overlay outline-hidden",
						"opacity-100 transition-[translate,scale,opacity] duration-200 ease-snappy data-[ending-style]:-translate-y-2 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:translate-y-2 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 motion-reduce:transition-none motion-reduce:data-[ending-style]:translate-y-0 motion-reduce:data-[starting-style]:translate-y-0",
					)}
					style={{ insetBlockStart: "14dvh" }}
				>
					<Dialog.Title className="sr-only">Command bar</Dialog.Title>
					<Dialog.Description className="sr-only">
						{commandMode === "move-file"
							? "Search destination folders and move a Markdown file."
							: "Search files, switch workspaces, and open Notion pages."}
					</Dialog.Description>
					<Command
						label="Command bar"
						value={selectedValue}
						onValueChange={setSelectedValue}
						shouldFilter={false}
						loop
					>
						<div className="relative flex min-h-11 items-center gap-2 border-b border-border px-3">
							<MingcuteSearchLine className="size-4 shrink-0 text-muted-foreground" />
							<Command.Input
								ref={inputRef}
								value={query}
								onValueChange={setQuery}
								onKeyDown={handleInputKeyDown}
								placeholder={
									commandMode === "move-file"
										? "Search folders or @workspace"
										: "Search files, @workspace, @folder, or @notion"
								}
								className="h-11 min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-hidden placeholder:text-muted-foreground"
							/>
							<kbd className="rounded-[var(--radius-inner)] bg-muted px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground">
								Esc
							</kbd>
							{scopeOptions.length > 0 ? (
								<ScopeOptionPopover
									options={scopeOptions}
									selectedIndex={scopeOptionIndex}
									onSelect={selectScope}
								/>
							) : null}
						</div>
						<Command.List className="min-h-0 flex-1 overflow-y-auto p-1">
							{renderCommandContent({
								accountChoices,
								commandMode,
								fileResults,
								folderChoices,
								folderScope,
								moveError,
								moveIsLoadingFolders,
								moveSourceLabel,
								moveStatus,
								notionConnection,
								notionError,
								notionResults,
								notionScope,
								notionStatus,
								onSelectAccount: selectAccount,
								onSelectFile: selectPath,
								onSelectFolder: selectFolder,
								onSelectNotionResult: (result) =>
									void selectNotionResult(result),
								onSelectWorkspace: (choice) => void selectWorkspace(choice),
								onStartMoveCurrentFile: startMoveCurrentFile,
								openModeMoveLabel,
								showingNotion,
								showingWorkspace,
								workspaceChoices,
								workspaceError,
								workspaceStatus,
							})}
						</Command.List>
						<CommandFooter
							commandMode={commandMode}
							folderScope={folderScope}
							moveDestinationLabel={
								scopedMoveWorkspacePath
									? basename(scopedMoveWorkspacePath)
									: null
							}
							notionScope={notionScope}
							showingNotion={showingNotion}
							showingWorkspace={showingWorkspace}
							workspaceStatus={workspaceStatus}
						/>
					</Command>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function buildFolderScopeOptions({
	files,
	folders,
	workspacePath,
}: {
	files: FileEntry[];
	folders: FolderEntry[];
	workspacePath: string | null;
}) {
	const paths = new Set<string>();
	if (workspacePath) paths.add(workspacePath);
	for (const folder of folders) paths.add(folder.path);
	for (const file of files) {
		const relativePath = relativeWorkspacePath(file.path, workspacePath);
		const index = relativePath.lastIndexOf("/");
		if (index < 0 || !workspacePath) continue;
		paths.add(`${workspacePath}/${relativePath.slice(0, index)}`);
	}
	return [...paths]
		.map((path): FolderScopeOption => {
			const isRoot =
				workspacePath !== null &&
				path.toLocaleLowerCase() === workspacePath.toLocaleLowerCase();
			const relativePath = isRoot
				? "Workspace root"
				: relativeWorkspacePath(path, workspacePath);
			return {
				path,
				label: isRoot ? basename(path) : basename(relativePath),
				relativePath,
			};
		})
		.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function filterFolderOptions(folders: FolderScopeOption[], input: string) {
	const normalizedInput = normalizeChoiceText(input);
	if (!normalizedInput) return folders.slice(0, 30);
	return folders
		.filter((folder) =>
			normalizeChoiceText(`${folder.relativePath} ${folder.label}`).includes(
				normalizedInput,
			),
		)
		.slice(0, 30);
}

function filterAccounts(accounts: string[], input: string) {
	const normalizedInput = normalizeChoiceText(input);
	if (!normalizedInput) return accounts;
	return accounts.filter((account) =>
		normalizeChoiceText(account).includes(normalizedInput),
	);
}

function replaceFolderScope(query: string, folder: FolderScopeOption) {
	const scopeStart = query.lastIndexOf("@folder:");
	if (scopeStart < 0) return `@folder:${folder.relativePath} `;
	return `${query.slice(0, scopeStart)}@folder:${folder.relativePath} `;
}

function replaceNotionAccount(query: string, account: string) {
	const scopeStart = query.lastIndexOf("@notion");
	if (scopeStart < 0) return `@notion:${account} `;
	const beforeScope = query.slice(0, scopeStart);
	const afterScope = query.slice(scopeStart + "@notion".length);
	const remainingQuery = afterScope.startsWith(":")
		? afterScope.slice(1).replace(/^\S*/, "").trim()
		: afterScope.trim();
	return `${beforeScope}@notion:${account}${remainingQuery ? ` ${remainingQuery}` : " "}`;
}

function normalizeChoiceText(value: string) {
	return value.toLocaleLowerCase().trim();
}
