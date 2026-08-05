import { Button } from "@hubble.md/ui";
import {
	Sidebar as SharedSidebar,
	type SidebarFocusedItem,
	SidebarFrame,
} from "@mdly/workspace-kit";
import { useStoreValue } from "@simplestack/store/react";
import { memo, type ReactNode, useMemo } from "react";
import { toast } from "sonner";
import { desktopApi } from "../desktopApi";
import { revealFileLabel } from "../lib/revealFile";
import {
	createMarkdownFileInFolder,
	deleteFolder,
	deleteMarkdownFile,
	loadPath,
	moveSidebarItem,
	openWorkspace,
	renameMarkdownFile,
	setSidebarOpen,
	setSortMode,
	togglePinnedNote,
} from "../store/actions";
import {
	currentPathStore,
	sidebarOpenStore,
	workspaceStore,
} from "../store/state";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

function SidebarComponent({
	footer,
	onFocusedPathChange,
	onMoveFile,
}: {
	footer?: ReactNode;
	onFocusedPathChange?: (path: string | null) => void;
	onMoveFile?: (path: string) => void;
}) {
	const workspace = useStoreValue(workspaceStore);
	const sidebarOpen = useStoreValue(sidebarOpenStore);
	const currentPath = useStoreValue(currentPathStore);
	const { workspacePath, files, folders, pinnedNotes, sortMode } = workspace;

	// Memoized so re-renders triggered by unrelated state (e.g. switching the
	// current file) don't redo this O(workspace files) mapping when the file
	// list itself hasn't changed.
	const sidebarFiles = useMemo(() => {
		const pinnedSet = new Set(pinnedNotes);
		return files.map((file) => ({
			path: file.path,
			modifiedAt: file.modified_at,
			pinned: pinnedSet.has(file.path),
			isSymlink: file.is_symlink,
			symlinkTarget: file.symlink_target,
			symlinkTargetExists: file.symlink_target_exists,
			symlinkTargetInWorkspace: file.symlink_target_in_workspace,
			symlinkCanonicalPath: file.symlink_canonical_path,
		}));
	}, [files, pinnedNotes]);
	const sidebarFolders = useMemo(
		() =>
			folders.map((folder) => ({
				path: folder.path,
				modifiedAt: folder.modified_at,
				isSymlink: folder.is_symlink,
				symlinkTarget: folder.symlink_target,
				symlinkTargetExists: folder.symlink_target_exists,
				symlinkTargetInWorkspace: folder.symlink_target_in_workspace,
				symlinkCanonicalPath: folder.symlink_canonical_path,
			})),
		[folders],
	);

	if (!sidebarOpen) return null;
	const collapseSidebar = () => setSidebarOpen(false);
	if (!workspacePath) {
		return (
			<SidebarFrame onCollapse={collapseSidebar}>
				<div className="flex min-h-0 flex-1 flex-col items-start justify-center gap-3 px-3 text-sm">
					<div className="flex flex-col gap-1">
						<p className="font-medium text-sidebar-foreground">
							No folder selected
						</p>
						<p className="text-sidebar-foreground/70">
							Add a folder to browse files.
						</p>
					</div>
					<Button size="sm" onClick={() => void openWorkspace()}>
						Open folder
					</Button>
				</div>
				{footer ? (
					<div className="border-t border-sidebar-border p-2">{footer}</div>
				) : null}
			</SidebarFrame>
		);
	}

	const relativePath = (absPath: string) => {
		const prefix = workspacePath.endsWith("/")
			? workspacePath
			: `${workspacePath}/`;
		return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
	};
	const absolutePath = (displayPath: string | null) => {
		if (!displayPath) return workspacePath;
		const normalized = displayPath.replace(/\/+$/, "");
		return workspacePath.endsWith("/")
			? `${workspacePath}${normalized}`
			: `${workspacePath}/${normalized}`;
	};
	const copyFilePath = async (path: string) => {
		try {
			await navigator.clipboard.writeText(path);
			toast.success("File path copied");
		} catch {
			toast.error("Failed to copy file path");
		}
	};

	return (
		<SharedSidebar
			files={sidebarFiles}
			folders={sidebarFolders}
			currentPath={currentPath ?? null}
			sortMode={sortMode}
			storageScope={workspacePath}
			header={<WorkspaceSwitcher />}
			footer={footer}
			getDisplayPath={relativePath}
			onCollapse={collapseSidebar}
			onSortModeChange={setSortMode}
			onSelectFile={(path) => void loadPath(path)}
			onRevealFile={(path) => void desktopApi.revealFile(path)}
			onCopyFilePath={(path) => void copyFilePath(path)}
			onCopySymlinkTarget={(path) =>
				void navigator.clipboard
					.writeText(path)
					.then(() => toast.success("Symlink target path copied"))
					.catch(() => toast.error("Failed to copy symlink target path"))
			}
			onBrokenSymlink={() => toast.error("Symlink target is missing")}
			onMoveFile={onMoveFile}
			onRevealFolder={(folderId) =>
				void desktopApi.revealFile(absolutePath(folderId))
			}
			onFocusedItemChange={(item: SidebarFocusedItem) => {
				if (!item) {
					onFocusedPathChange?.(null);
					return;
				}
				onFocusedPathChange?.(
					item.kind === "file" ? item.path : absolutePath(item.folderId),
				);
			}}
			revealLabel={revealFileLabel(desktopApi.platform)}
			onRenameFile={(path, nextName) => void renameMarkdownFile(path, nextName)}
			onDeleteFile={(path) => void deleteMarkdownFile(path)}
			onTogglePinnedFile={(path) => void togglePinnedNote(path)}
			onCreateFile={(folderId) =>
				createMarkdownFileInFolder(absolutePath(folderId))
			}
			onDeleteFolder={(folderId) => void deleteFolder(absolutePath(folderId))}
			onMoveItem={({ item, targetFolderId }) =>
				void moveSidebarItem(item, absolutePath(targetFolderId))
			}
		/>
	);
}

// Memoized: App re-renders on every editor keystroke (document store update).
// Without this, Sidebar would re-run its O(workspace files) mapping/tree build
// on every keystroke even though the file list didn't change.
export const Sidebar = memo(SidebarComponent);
