import { Button } from "@hubble.md/ui";
import {
	Sidebar as SharedSidebar,
	type SidebarFocusedItem,
	SidebarFrame,
} from "@mdly/workspace-kit";
import { useStoreValue } from "@simplestack/store/react";
import {
	memo,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
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

	// Tags are read out of front matter, which workspace discovery deliberately
	// never opens files to get (ADR-0008). So the scan is deferred until the
	// user actually opens the Tags page, and its result lives here as ephemeral
	// navigation state rather than in the persisted store.
	const [activeTag, setActiveTag] = useState<string | null>(null);
	const [tagsRequested, setTagsRequested] = useState(false);
	const [tagsByPath, setTagsByPath] = useState<Record<string, string[]>>({});
	const [searchQuery, setSearchQuery] = useState("");

	// A different workspace's tags (and query) are meaningless here; drop them
	// and make the next visit to the Tags page rescan. Reset during render rather
	// than in an effect so the stale state never paints for a frame -- same
	// pattern the kit's own Sidebar uses to reset its page on a workspace change.
	const [tagWorkspaceScope, setTagWorkspaceScope] = useState(workspacePath);
	if (tagWorkspaceScope !== workspacePath) {
		setTagWorkspaceScope(workspacePath);
		setActiveTag(null);
		setTagsRequested(false);
		setTagsByPath({});
		setSearchQuery("");
	}

	// Reruns when the file list changes so tags don't go stale after edits,
	// but only once the user has shown interest in them.
	useEffect(() => {
		if (!tagsRequested) return;
		let cancelled = false;
		void desktopApi
			.scanFrontMatterTags(files.map((file) => file.path))
			.then((result) => {
				if (!cancelled) setTagsByPath(result);
			})
			.catch(() => {
				// A failed scan just means no tags to show -- never break the sidebar.
			});
		return () => {
			cancelled = true;
		};
	}, [tagsRequested, files]);

	const handlePageChange = useCallback((pageId: string) => {
		if (pageId === "tags") setTagsRequested(true);
	}, []);
	const handleSelectTag = useCallback(
		(name: string) =>
			setActiveTag((current) => (current === name ? null : name)),
		[],
	);

	// Declared up here, above the early returns, so it can be a stable callback:
	// the kit memoizes both its file tree and its search index on this
	// function's identity, and a fresh closure per render rebuilds both on every
	// keystroke in the editor.
	const relativePath = useCallback(
		(absPath: string) => {
			if (!workspacePath) return absPath;
			const prefix = workspacePath.endsWith("/")
				? workspacePath
				: `${workspacePath}/`;
			return absPath.startsWith(prefix)
				? absPath.slice(prefix.length)
				: absPath;
		},
		[workspacePath],
	);

	// Memoized so re-renders triggered by unrelated state (e.g. switching the
	// current file) don't redo this O(workspace files) mapping when the file
	// list itself hasn't changed.
	const sidebarFiles = useMemo(() => {
		const pinnedSet = new Set(pinnedNotes);
		return files.map((file) => ({
			path: file.path,
			modifiedAt: file.modified_at,
			pinned: pinnedSet.has(file.path),
			tags: tagsByPath[file.path],
			isSymlink: file.is_symlink,
			symlinkTarget: file.symlink_target,
			symlinkTargetExists: file.symlink_target_exists,
			symlinkTargetInWorkspace: file.symlink_target_in_workspace,
			symlinkCanonicalPath: file.symlink_canonical_path,
		}));
	}, [files, pinnedNotes, tagsByPath]);
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
			activeTag={activeTag}
			onSelectTag={handleSelectTag}
			onPageChange={handlePageChange}
			tagsEmptyState={
				<p className="px-2 py-3 text-[11px] text-muted-foreground">
					No tags found in this folder's front matter.
				</p>
			}
			searchQuery={searchQuery}
			onSearchChange={setSearchQuery}
			searchPlaceholder="Search files"
		/>
	);
}

// Memoized: App re-renders on every editor keystroke (document store update).
// Without this, Sidebar would re-run its O(workspace files) mapping/tree build
// on every keystroke even though the file list didn't change.
export const Sidebar = memo(SidebarComponent);
