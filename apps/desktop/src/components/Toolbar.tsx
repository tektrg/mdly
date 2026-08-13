import { Menu } from "@base-ui/react/menu";
import { Button } from "@hubble.md/ui";
import { useStoreValue } from "@simplestack/store/react";
import { toast } from "sonner";
import MingcuteCopy2Line from "~icons/mingcute/copy-2-line";
import MingcuteFolderOpenLine from "~icons/mingcute/folder-open-line";
import MingcuteLinkLine from "~icons/mingcute/link-line";
import MingcuteMore2Line from "~icons/mingcute/more-2-line";
import { desktopApi } from "../desktopApi";
import { revealFileLabel } from "../lib/revealFile";
import { currentPathStore, workspacePathStore } from "../store/state";

type NotionSyncMode = "none" | "page" | "database";

export function Toolbar({
	onOpenNotionPage,
	onOpenNotionInBrowser,
	onPushNotionPage,
	onRefreshNotionPage,
	onReimportDoc,
	onMoveCurrentFile,
	notionSyncMode,
	docImported,
}: {
	scrollContainer: HTMLDivElement | null;
	showSidebarBadge?: boolean;
	onOpenNotionPage: () => void;
	onOpenNotionInBrowser: () => void;
	onPushNotionPage: () => void;
	onRefreshNotionPage: () => void;
	onReimportDoc: () => void;
	onMoveCurrentFile: () => void;
	notionSyncMode: NotionSyncMode;
	docImported: boolean;
}) {
	const workspacePath = useStoreValue(workspacePathStore);
	const currentPath = useStoreValue(currentPathStore);
	if (!workspacePath) return null;

	return (
		<div className="desktop-window-no-drag pointer-events-none fixed end-3 top-3 z-30">
			<NoteActionsMenu
				path={currentPath ?? null}
				onOpenNotionPage={onOpenNotionPage}
				onOpenNotionInBrowser={onOpenNotionInBrowser}
				onPushNotionPage={onPushNotionPage}
				onRefreshNotionPage={onRefreshNotionPage}
				onReimportDoc={onReimportDoc}
				onMoveFile={onMoveCurrentFile}
				notionSyncMode={notionSyncMode}
				docImported={docImported}
			/>
		</div>
	);
}

function NoteActionsMenu({
	path,
	onOpenNotionPage,
	onOpenNotionInBrowser,
	onPushNotionPage,
	onRefreshNotionPage,
	onReimportDoc,
	onMoveFile,
	notionSyncMode,
	docImported,
}: {
	path: string | null;
	onOpenNotionPage: () => void;
	onOpenNotionInBrowser: () => void;
	onPushNotionPage: () => void;
	onRefreshNotionPage: () => void;
	onReimportDoc: () => void;
	onMoveFile: () => void;
	notionSyncMode: NotionSyncMode;
	docImported: boolean;
}) {
	async function revealFile() {
		if (!path) return;
		try {
			await desktopApi.revealFile(path);
		} catch {
			toast.error("Failed to reveal file");
		}
	}

	async function copyFilePath() {
		if (!path) return;
		try {
			await navigator.clipboard.writeText(path);
			toast.success("File path copied");
		} catch {
			toast.error("Failed to copy file path");
		}
	}

	return (
		<Menu.Root>
			<Menu.Trigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						className="pointer-events-auto rounded-full border border-border/50 bg-background/78 text-muted-foreground shadow-[0_2px_8px_rgb(15_23_42/0.045)] backdrop-blur-md hover:bg-accent"
						aria-label="Note actions"
						title="Note actions"
					/>
				}
			>
				<MingcuteMore2Line className="size-4" />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner className="z-50" align="end" side="bottom" sideOffset={4}>
					<Menu.Popup className="w-44 origin-(--transform-origin) rounded-sm border border-border bg-popover p-1 text-[11px] text-popover-foreground outline-hidden transition-[transform,opacity] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
						<Menu.Item
							className="flex w-full cursor-pointer items-center gap-2 rounded-sm [padding-block:0.375rem] [padding-inline:0.5rem] text-start text-[11px] outline-hidden select-none data-highlighted:bg-accent"
							onClick={onOpenNotionPage}
						>
							<MingcuteLinkLine className="size-3 shrink-0" />
							<span className="min-w-0 flex-1">Open Notion page</span>
						</Menu.Item>
						{notionSyncMode !== "none" ? (
							<>
								<Menu.Separator className="my-1 h-px bg-border" />
								<Menu.Item
									className="flex w-full cursor-pointer items-center gap-2 rounded-sm [padding-block:0.375rem] [padding-inline:0.5rem] text-start text-[11px] outline-hidden select-none data-highlighted:bg-accent"
									onClick={onOpenNotionInBrowser}
								>
									<MingcuteLinkLine className="size-3 shrink-0" />
									<span className="min-w-0 flex-1">Open in Notion</span>
								</Menu.Item>
								{notionSyncMode === "page" ? (
									<Menu.Item
										className="flex w-full cursor-pointer items-center gap-2 rounded-sm [padding-block:0.375rem] [padding-inline:0.5rem] text-start text-[11px] outline-hidden select-none data-highlighted:bg-accent"
										onClick={onPushNotionPage}
									>
										<MingcuteLinkLine className="size-3 shrink-0" />
										<span className="min-w-0 flex-1">Push to Notion</span>
									</Menu.Item>
								) : null}
								<Menu.Item
									className="flex w-full cursor-pointer items-center gap-2 rounded-sm [padding-block:0.375rem] [padding-inline:0.5rem] text-start text-[11px] outline-hidden select-none data-highlighted:bg-accent"
									onClick={onRefreshNotionPage}
								>
									<MingcuteLinkLine className="size-3 shrink-0" />
									<span className="min-w-0 flex-1">Refresh from Notion</span>
								</Menu.Item>
							</>
						) : null}
						{docImported ? (
							<>
								<Menu.Separator className="my-1 h-px bg-border" />
								<Menu.Item
									className="flex w-full cursor-pointer items-center gap-2 rounded-sm [padding-block:0.375rem] [padding-inline:0.5rem] text-start text-[11px] outline-hidden select-none data-highlighted:bg-accent"
									onClick={onReimportDoc}
								>
									<MingcuteLinkLine className="size-3 shrink-0" />
									<span className="min-w-0 flex-1">Re-import from source</span>
								</Menu.Item>
							</>
						) : null}
						{path ? <Menu.Separator className="my-1 h-px bg-border" /> : null}
						{path ? (
							<>
								<Menu.Item
									className="flex w-full cursor-pointer items-center gap-2 rounded-sm [padding-block:0.375rem] [padding-inline:0.5rem] text-start text-[11px] outline-hidden select-none data-highlighted:bg-accent"
									onClick={() => void revealFile()}
								>
									<MingcuteFolderOpenLine className="size-3 shrink-0" />
									<span className="min-w-0 flex-1">
										{revealFileLabel(desktopApi.platform)}
									</span>
									<ShortcutHint>⌘⌥R</ShortcutHint>
								</Menu.Item>
								<Menu.Item
									className="flex w-full cursor-pointer items-center gap-2 rounded-sm [padding-block:0.375rem] [padding-inline:0.5rem] text-start text-[11px] outline-hidden select-none data-highlighted:bg-accent"
									onClick={onMoveFile}
								>
									<MingcuteFolderOpenLine className="size-3 shrink-0" />
									<span className="min-w-0 flex-1">Move to...</span>
								</Menu.Item>
								<Menu.Item
									className="flex w-full cursor-pointer items-center gap-2 rounded-sm [padding-block:0.375rem] [padding-inline:0.5rem] text-start text-[11px] outline-hidden select-none data-highlighted:bg-accent"
									onClick={() => void copyFilePath()}
								>
									<MingcuteCopy2Line className="size-3 shrink-0" />
									<span className="min-w-0 flex-1">Copy file path</span>
									<ShortcutHint>⌘⇧C</ShortcutHint>
								</Menu.Item>
							</>
						) : null}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

function ShortcutHint({ children }: { children: string }) {
	return (
		<span
			className="ms-auto shrink-0 text-[11px] leading-none text-muted-foreground/60"
			aria-hidden="true"
		>
			{children}
		</span>
	);
}
