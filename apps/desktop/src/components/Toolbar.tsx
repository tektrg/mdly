import { Menu } from "@base-ui/react/menu";
import { Button, Toolbar as SharedToolbar } from "@hubble.md/ui";
import { useStoreValue } from "@simplestack/store/react";
import { type CSSProperties, useEffect, useState } from "react";
import { toast } from "sonner";
import MingcuteCopy2Line from "~icons/mingcute/copy-2-line";
import MingcuteFolderOpenLine from "~icons/mingcute/folder-open-line";
import MingcuteLinkLine from "~icons/mingcute/link-line";
import MingcuteMore2Line from "~icons/mingcute/more-2-line";
import { desktopApi } from "../desktopApi";
import { revealFileLabel } from "../lib/revealFile";
import { renameCurrentMarkdownFile, toggleSidebar } from "../store/actions";
import {
	currentPathStore,
	sidebarOpenStore,
	workspacePathStore,
} from "../store/state";

const dragRegionStyle = {
	WebkitAppRegion: "drag",
} as CSSProperties;

type NotionSyncMode = "none" | "page" | "database";

// Traffic lights are hidden in fullscreen, so drop their reserved inset.
function useIsFullScreen() {
	const [isFullScreen, setIsFullScreen] = useState(false);
	useEffect(() => {
		void desktopApi.getFullScreen().then(setIsFullScreen);
		return desktopApi.onFullScreenChange(setIsFullScreen);
	}, []);
	return isFullScreen;
}

export function Toolbar({
	scrollContainer,
	showSidebarBadge = false,
	onOpenNotionPage,
	onPushNotionPage,
	onRefreshNotionPage,
	notionSyncMode,
}: {
	scrollContainer: HTMLDivElement | null;
	showSidebarBadge?: boolean;
	onOpenNotionPage: () => void;
	onPushNotionPage: () => void;
	onRefreshNotionPage: () => void;
	notionSyncMode: NotionSyncMode;
}) {
	const workspacePath = useStoreValue(workspacePathStore);
	const sidebarOpen = useStoreValue(sidebarOpenStore);
	const currentPath = useStoreValue(currentPathStore);
	const isFullScreen = useIsFullScreen();

	return (
		<SharedToolbar
			currentPath={currentPath ?? null}
			sidebarOpen={sidebarOpen}
			sidebarBadge={showSidebarBadge}
			scrollContainer={scrollContainer}
			platformInset={!isFullScreen}
			rootProps={{ style: dragRegionStyle }}
			onToggleSidebar={toggleSidebar}
			onRenameCurrentPath={(nextName) =>
				void renameCurrentMarkdownFile(nextName)
			}
			rightSlot={
				workspacePath ? (
					<NoteActionsMenu
						path={currentPath ?? null}
						onOpenNotionPage={onOpenNotionPage}
						onPushNotionPage={onPushNotionPage}
						onRefreshNotionPage={onRefreshNotionPage}
						notionSyncMode={notionSyncMode}
					/>
				) : undefined
			}
		/>
	);
}

function NoteActionsMenu({
	path,
	onOpenNotionPage,
	onPushNotionPage,
	onRefreshNotionPage,
	notionSyncMode,
}: {
	path: string | null;
	onOpenNotionPage: () => void;
	onPushNotionPage: () => void;
	onRefreshNotionPage: () => void;
	notionSyncMode: NotionSyncMode;
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
						aria-label="Note actions"
						title="Note actions"
					/>
				}
			>
				<MingcuteMore2Line className="size-4" />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner align="end" side="bottom" sideOffset={4}>
					<Menu.Popup className="z-50 w-44 origin-(--transform-origin) rounded-sm border border-border bg-popover p-1 text-[11px] text-popover-foreground outline-hidden transition-[transform,opacity] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
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
