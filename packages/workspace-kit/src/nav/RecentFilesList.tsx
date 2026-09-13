import { forwardRef, useCallback, useMemo, useRef } from "react";
import MingcuteCalendarAddLine from "~icons/mingcute/calendar-add-line";
import MingcuteHistoryLine from "~icons/mingcute/history-line";
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

/** Exact box the host's own recent-recordings tag chip uses -- see TagChip in InboxView/TagEditor.tsx. */
export type RecentTagAppearance = {
	background: string;
	color: string;
	/** Full CSS `border` shorthand. Defaults to the reference chip's own default (invisible unless the host wants one visible, e.g. to mark provenance). */
	border?: string;
};

const DEFAULT_TAG_APPEARANCE: Required<RecentTagAppearance> = {
	background: "var(--muted)",
	color: "var(--muted-foreground)",
	border: "0.5px solid transparent",
};

/**
 * Small tag chips under a recent-file row -- pixel-for-pixel the same chip
 * box as the host's own recent-recordings tag list (22px tall, 8px/5px
 * left/right padding, fully rounded, 11.5px/500-weight text), painted from
 * whatever `getAppearance` returns so the colors match exactly too, not just
 * the shape. Rendered whenever the row has tags, with or without
 * `getAppearance`; absent both `tags` and `getAppearance`, this returns null
 * and the row is byte-for-byte what it was before tags existed on this page.
 */
function RecentFileTags({
	tags,
	getAppearance,
}: {
	tags: readonly string[];
	getAppearance?: (name: string) => RecentTagAppearance;
}) {
	if (tags.length === 0) return null;
	return (
		<span className="flex min-w-0 flex-wrap items-center gap-1.5">
			{tags.map((name) => {
				const appearance = getAppearance?.(name);
				return (
					<span
						key={name}
						className="inline-flex min-w-0 shrink-0 items-center truncate"
						style={{
							height: 22,
							padding: "0 5px 0 8px",
							borderRadius: 999,
							fontSize: 11.5,
							fontWeight: 500,
							background: appearance?.background ?? DEFAULT_TAG_APPEARANCE.background,
							color: appearance?.color ?? DEFAULT_TAG_APPEARANCE.color,
							border: appearance?.border ?? DEFAULT_TAG_APPEARANCE.border,
						}}
					>
						{name}
					</span>
				);
			})}
		</span>
	);
}

function formatRecentTimestamp(ms: number): string {
	return new Date(ms).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

/**
 * Created/updated timestamps under a recent-file row, styled as the same
 * icon+label metadata pairs the host's own recent-recordings list uses
 * (leading glyph, muted small text, one pair per fact). Only rendered when
 * the host supplies `createdAt` -- rows from hosts that never set it
 * (existing behavior) render exactly as before.
 */
function RecentFileTimestamps({
	createdAt,
	modifiedAt,
}: {
	createdAt: number;
	modifiedAt: number | undefined;
}) {
	const updated = modifiedAt ?? createdAt;
	return (
		<span className="flex min-w-0 items-center gap-3 text-[10px] text-muted-foreground/70">
			<span className="flex shrink-0 items-center gap-1">
				<MingcuteCalendarAddLine className="size-[11px]" />
				{formatRecentTimestamp(createdAt)}
			</span>
			<span className="flex shrink-0 items-center gap-1">
				<MingcuteHistoryLine className="size-[11px]" />
				{formatRecentTimestamp(updated)}
			</span>
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
		/** Per-tag chip colors (background/color/border), e.g. the host's own tag hue. */
		getTagAppearance?: (name: string) => RecentTagAppearance;
	}
>(function RecentFilesList(
	{
		files,
		currentPath,
		getDisplayPath,
		onSelectFile,
		getTagAppearance,
	},
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
								"flex w-full min-w-0 flex-col gap-1.5 rounded-[var(--radius-row)] px-2.5 py-2 text-start text-[length:var(--font-size-sidebar)] text-sidebar-foreground outline-hidden hover:bg-accent",
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
							<RecentFileTags tags={file.tags ?? []} getAppearance={getTagAppearance} />
							{file.createdAt != null ? (
								<RecentFileTimestamps
									createdAt={file.createdAt}
									modifiedAt={file.modifiedAt}
								/>
							) : null}
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
