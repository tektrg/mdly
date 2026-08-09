import { forwardRef, useCallback, useMemo, useRef } from "react";
import {
	dirname,
	fileNameFromPath,
	normalizeDisplayPath,
} from "../lib/filePath";
import { cn } from "../lib/utils";
import {
	buildRecentFilesList,
	RECENT_FILES_LIMIT,
} from "./buildRecentFilesList";
import { useSidebarKeyboardNav } from "./useSidebarKeyboardNav";
import type { SidebarFile } from "./useSidebarTree";
import { useVirtualSidebarRows } from "./useVirtualSidebarRows";

/** Renders a folder path with the innermost folder always visible and the rest ellipsized from the front. */
function MiddleTruncatedPath({ path }: { path: string }) {
	const separator = path.includes("\\") ? "\\" : "/";
	const segments = path.split(separator);
	const tail = segments.pop() ?? "";
	const head =
		segments.length > 0 ? `${segments.join(separator)}${separator}` : "";

	return (
		<span className="flex min-w-0 text-[10px] text-muted-foreground/70">
			<span className="min-w-0 truncate">{head}</span>
			<span className="shrink-0 whitespace-nowrap">{tail}</span>
		</span>
	);
}

/**
 * Flat, folder-less view of the workspace's most recently modified files.
 * Quick-open only by design: no rename/delete/pin/drag affordances here —
 * those live in the folder-tree page (`Sidebar`'s `tree` view). See
 * memory/Projects/hubble-web-port for the product decisions behind this scope.
 *
 * Forwards a ref to its scrollable/keyboard-navigable container so `Sidebar`
 * can move focus here when the user switches to this page.
 */
export const RecentFilesList = forwardRef<
	HTMLDivElement,
	{
		files: SidebarFile[];
		currentPath: string | null;
		getDisplayPath: (path: string) => string;
		onSelectFile: (path: string) => void;
	}
>(function RecentFilesList(
	{ files, currentPath, getDisplayPath, onSelectFile },
	forwardedRef,
) {
	const navRef = useRef<HTMLDivElement>(null);
	const setNavRef = useCallback(
		(node: HTMLDivElement | null) => {
			navRef.current = node;
			if (typeof forwardedRef === "function") forwardedRef(node);
			else if (forwardedRef) forwardedRef.current = node;
		},
		[forwardedRef],
	);
	const recentFiles = useMemo(() => buildRecentFilesList(files), [files]);
	const showRecentFilesHint = files.length > RECENT_FILES_LIMIT;
	const activeIndex = recentFiles.findIndex(
		(file) => file.path === currentPath,
	);

	const activateFile = useCallback(
		(file: SidebarFile) => onSelectFile(file.path),
		[onSelectFile],
	);

	const { focusedIndex, onKeyDown } = useSidebarKeyboardNav({
		items: recentFiles,
		onSelect: activateFile,
		navRef,
		activeIndex,
	});

	const virtualRows = useVirtualSidebarRows({
		rows: recentFiles,
		scrollRef: navRef,
	});

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div
				ref={setNavRef}
				role="listbox"
				aria-label="Recent files"
				className="flex-1 overflow-y-auto overscroll-contain px-1.5 py-1 outline-none"
				tabIndex={0}
				onKeyDown={onKeyDown}
			>
				{recentFiles.length === 0 ? (
					<p className="px-2 py-3 text-[11px] text-muted-foreground">
						No recently modified files.
					</p>
				) : null}
				{virtualRows.paddingTop > 0 ? (
					<div aria-hidden="true" style={{ height: virtualRows.paddingTop }} />
				) : null}
				{virtualRows.items.map(({ row: file, index }) => {
					const isActive = file.path === currentPath;
					const isFocused = focusedIndex === index;
					const displayPath = normalizeDisplayPath(getDisplayPath(file.path));
					const parentPath = dirname(displayPath);
					return (
						<button
							key={file.path}
							type="button"
							role="option"
							data-sidebar-index={index}
							aria-selected={isActive}
							title={displayPath}
							className={cn(
								"flex w-full min-w-0 flex-col gap-0.5 rounded-[var(--radius-row)] px-2 py-1 text-start text-[length:var(--font-size-sidebar)] text-sidebar-foreground outline-hidden hover:bg-accent",
								!isActive && isFocused && "bg-accent",
								isActive &&
									"bg-sidebar-accent text-sidebar-accent-foreground font-medium",
							)}
							onClick={() => activateFile(file)}
						>
							<span className="block min-w-0 truncate">
								{fileNameFromPath(displayPath)}
							</span>
							{parentPath ? <MiddleTruncatedPath path={parentPath} /> : null}
						</button>
					);
				})}
				{virtualRows.paddingBottom > 0 ? (
					<div
						aria-hidden="true"
						style={{ height: virtualRows.paddingBottom }}
					/>
				) : null}
			</div>
			{showRecentFilesHint ? (
				<p className="shrink-0 px-2 py-1.5 text-center text-[10px] text-muted-foreground/70">
					Showing {RECENT_FILES_LIMIT} most recent files
				</p>
			) : null}
		</div>
	);
});
