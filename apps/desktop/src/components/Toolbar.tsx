import { Menu } from "@base-ui/react/menu";
import { Button } from "@hubble.md/ui";
import { useStoreValue } from "@simplestack/store/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import MingcuteCopy2Line from "~icons/mingcute/copy-2-line";
import MingcuteFolderOpenLine from "~icons/mingcute/folder-open-line";
import MingcuteHistoryLine from "~icons/mingcute/history-line";
import MingcuteLinkLine from "~icons/mingcute/link-line";
import MingcuteMessage3Line from "~icons/mingcute/message-3-line";
import MingcuteMore2Line from "~icons/mingcute/more-2-line";
import { desktopApi } from "../desktopApi";
import { revealFileLabel } from "../lib/revealFile";
import { undoExternalChange } from "../store/actions";
import {
	currentPathStore,
	viewerStore,
	workspacePathStore,
} from "../store/state";
import { ExternalChangeReviewDialog } from "./ExternalChangeReviewDialog";

type NotionSyncMode = "none" | "page" | "database";

// Shared segment style for the title-bar pill: flat until hovered, no radius
// or border of its own -- the pill's outer rounded-full + overflow-hidden
// clips every segment (including the "..." trigger) to one continuous shape.
const PILL_SEGMENT_CLASS =
	"pointer-events-auto rounded-none text-muted-foreground hover:bg-accent hover:text-foreground";

export function Toolbar({
	onOpenNotionPage,
	onOpenNotionInBrowser,
	onPushNotionPage,
	onRefreshNotionPage,
	onReimportDoc,
	onMoveCurrentFile,
	onOpenRevisionHistory,
	onOpenComments,
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
	onOpenRevisionHistory: () => void;
	onOpenComments: () => void;
	notionSyncMode: NotionSyncMode;
	docImported: boolean;
}) {
	const workspacePath = useStoreValue(workspacePathStore);
	const currentPath = useStoreValue(currentPathStore);
	const externalChange = useStoreValue(
		viewerStore,
		(viewer) => viewer.externalChange,
	);
	const currentContent = useStoreValue(viewerStore, (viewer) => viewer.content);
	const hasAppliedChange = externalChange.kind === "applied";
	const [reviewOpen, setReviewOpen] = useState(false);
	const [pendingSyncCount, setPendingSyncCount] = useState(0);
	// The review dialog is scoped to the document it was opened for (R27's
	// per-document scoping precedent, same as the history/comments panels in
	// App.tsx). Without this, switching to a different note while the dialog
	// is open would leave it open and silently retarget it at the new note's
	// externalChange/content -- a dialog the user never asked to open for
	// that note, potentially with an "Undo" that reverts a change they never
	// reviewed.
	// biome-ignore lint/correctness/useExhaustiveDependencies: currentPath is the reset signal, not read in the body.
	useEffect(() => {
		setReviewOpen(false);
	}, [currentPath]);

	// Passive pending-folders badge (D-LW5): Settings is somewhere you have
	// to go look, so the main window surfaces the count. Read-only — it never
	// starts or stops sync.
	useEffect(() => {
		if (!workspacePath) {
			setPendingSyncCount(0);
			return;
		}
		let cancelled = false;
		void desktopApi
			.getCloudSyncState(workspacePath)
			.then((initial) => {
				if (!cancelled) setPendingSyncCount(initial.pendingFolders?.length ?? 0);
			})
			.catch(() => {});
		let unsubscribe: (() => void) | undefined;
		void desktopApi
			.onCloudSyncStatusChange(workspacePath, () => {
				if (cancelled) return;
				void desktopApi
					.getCloudSyncState(workspacePath)
					.then((next) => {
						if (!cancelled)
							setPendingSyncCount(next.pendingFolders?.length ?? 0);
					})
					.catch(() => {});
			})
			.then((fn) => {
				if (cancelled) fn();
				else unsubscribe = fn;
			});
		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, [workspacePath]);

	if (!workspacePath) return null;

	return (
		<>
			<div className="desktop-window-no-drag pointer-events-none fixed end-3 top-3 z-30">
				<div className="pointer-events-auto flex items-center overflow-hidden rounded-full border border-border/50 bg-background/78 shadow-[0_2px_8px_rgb(15_23_42/0.045)] backdrop-blur-md">
					{hasAppliedChange && (
						<>
							<Button
								variant="ghost"
								size="sm"
								className={PILL_SEGMENT_CLASS}
								onClick={() => setReviewOpen(true)}
							>
								Review external change
							</Button>
							<PillDivider />
						</>
					)}
					{pendingSyncCount > 0 && (
						<>
							<span
								className={`${PILL_SEGMENT_CLASS} cursor-default [padding-inline:0.625rem] [padding-block:0.375rem] text-[11px]`}
								title={`${pendingSyncCount} folder${pendingSyncCount === 1 ? "" : "s"} waiting for sync approval — see Settings → Cloud Sync`}
							>
								Sync: {pendingSyncCount} pending
							</span>
							<PillDivider />
						</>
					)}
					<NoteActionsMenu
						path={currentPath ?? null}
						onOpenNotionPage={onOpenNotionPage}
						onOpenNotionInBrowser={onOpenNotionInBrowser}
						onPushNotionPage={onPushNotionPage}
						onRefreshNotionPage={onRefreshNotionPage}
						onReimportDoc={onReimportDoc}
						onMoveFile={onMoveCurrentFile}
						onOpenRevisionHistory={onOpenRevisionHistory}
						onOpenComments={onOpenComments}
						notionSyncMode={notionSyncMode}
						docImported={docImported}
					/>
				</div>
			</div>
			{hasAppliedChange && externalChange.kind === "applied" && (
				<ExternalChangeReviewDialog
					open={reviewOpen}
					onOpenChange={setReviewOpen}
					previousContent={externalChange.previousContent}
					currentContent={currentContent}
					onUndo={() => void undoExternalChange()}
				/>
			)}
		</>
	);
}

function PillDivider() {
	return <div aria-hidden="true" className="h-4 w-px shrink-0 bg-border/60" />;
}

function NoteActionsMenu({
	path,
	onOpenNotionPage,
	onOpenNotionInBrowser,
	onPushNotionPage,
	onRefreshNotionPage,
	onReimportDoc,
	onMoveFile,
	onOpenRevisionHistory,
	onOpenComments,
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
	onOpenRevisionHistory: () => void;
	onOpenComments: () => void;
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
						className={PILL_SEGMENT_CLASS}
						aria-label="Note actions"
						title="Note actions"
					/>
				}
			>
				<MingcuteMore2Line className="size-4" />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					className="z-50"
					align="end"
					side="bottom"
					sideOffset={4}
				>
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
								<Menu.Item
									className="flex w-full cursor-pointer items-center gap-2 rounded-sm [padding-block:0.375rem] [padding-inline:0.5rem] text-start text-[11px] outline-hidden select-none data-highlighted:bg-accent"
									onClick={onOpenRevisionHistory}
								>
									<MingcuteHistoryLine className="size-3 shrink-0" />
									<span className="min-w-0 flex-1">View revision history</span>
								</Menu.Item>
								<Menu.Item
									className="flex w-full cursor-pointer items-center gap-2 rounded-sm [padding-block:0.375rem] [padding-inline:0.5rem] text-start text-[11px] outline-hidden select-none data-highlighted:bg-accent"
									onClick={onOpenComments}
								>
									<MingcuteMessage3Line className="size-3 shrink-0" />
									<span className="min-w-0 flex-1">View comments</span>
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
