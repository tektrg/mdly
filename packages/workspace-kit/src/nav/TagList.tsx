import {
	forwardRef,
	type ReactNode,
	type Ref,
	useCallback,
	useRef,
} from "react";
import { cn } from "../lib/utils";
import type { SidebarTag } from "./buildTagCounts";
import { TagTreeView } from "./TagTree";
import { useSidebarKeyboardNav } from "./useSidebarKeyboardNav";
import type { SidebarFile, SidebarSortMode } from "./useSidebarTree";
import { useVirtualSidebarRows } from "./useVirtualSidebarRows";

export type TagListProps = {
	tags: readonly SidebarTag[];
	activeTag: string | null;
	onSelect: (name: string) => void;
	/** Per-row leading glyph, e.g. a host's own colored tag badge. */
	renderIcon?: (name: string) => ReactNode;
	/** Row label, when the host writes tags differently (e.g. a `#` prefix). */
	formatLabel?: (name: string) => string;
	emptyState?: ReactNode;
	/**
	 * Separator that nests the list into a tree (e.g. `"/"` turns
	 * `meeting/deep-sync` into a `meeting` group holding a `deep-sync` leaf).
	 * Opt-in: absent, the list below renders exactly the flat list it always
	 * has. The kit only splits on the separator — segment labels, colors and
	 * any humanizing come from the host via `formatGroupLabel` /
	 * `renderGroupIcon` (leaves keep `renderIcon` / `formatLabel`).
	 */
	tagSeparator?: string;
	/** Tree-mode group-row label for a group path (e.g. humanize it). Raw segment when absent. */
	formatGroupLabel?: (groupPath: string) => string;
	/** Tree-mode group-row leading glyph. */
	renderGroupIcon?: (groupPath: string) => ReactNode;
	/** Full file list, used only in tree mode to list files inline under an expanded tag. */
	files?: readonly SidebarFile[];
	/** Tree-mode file labels; defaults to the raw path. */
	getFileDisplayPath?: (path: string) => string;
	/** Tree-mode file activation for inline file rows. */
	onSelectFile?: (path: string) => void;
	/** Tree-mode highlight for the currently open inline file. */
	activeFilePath?: string | null;
	/** Tree-mode persistence scope for tag expansion (per workspace). */
	storageScope?: string | null;
	/**
	 * Tree-mode inline-file ordering, mirroring the folder tree: `"alpha"`
	 * sorts by file name, `"recent"` by last-modified (ties by name).
	 * Defaults to `"alpha"`.
	 */
	sortMode?: SidebarSortMode;
};

/**
 * Flat list of the workspace's tags with their file counts. Selection-only by
 * design -- no rename/delete/merge affordances here, mirroring
 * `RecentFilesList`'s "quick-jump only" scope.
 *
 * Presentational on purpose. Everything that differs between host apps stays
 * outside: where the tags came from, how they're colored (`renderIcon`), how
 * they're written (`formatLabel`), and what selecting one actually does
 * (`onSelect`). The kit owns the rows, the counts, the keyboard nav and the
 * virtualization -- nothing about tag semantics.
 *
 * Pass `tagSeparator` to opt into the hierarchical tree (`TagTreeView`):
 * namespaces nest series, and expanding a leaf reveals its files inline. The
 * flat list below stays the default and renders unchanged without it.
 *
 * Forwards a ref to its scrollable/keyboard-navigable container so the pager
 * can move focus here when the user switches to this page.
 */
export const TagList = forwardRef<HTMLDivElement, TagListProps>(
	function TagList(props, forwardedRef) {
		if ((props.tagSeparator?.length ?? 0) > 0) {
			return <TagTreeView {...props} forwardedRef={forwardedRef} />;
		}
		return <FlatTagListView {...props} forwardedRef={forwardedRef} />;
	},
);

const FlatTagListView = ({
	tags,
	activeTag,
	onSelect,
	renderIcon,
	formatLabel,
	emptyState,
	forwardedRef,
}: TagListProps & {
	forwardedRef: Ref<HTMLDivElement>;
}) => {
	const navRef = useRef<HTMLDivElement>(null);
	const setNavRef = useCallback(
		(node: HTMLDivElement | null) => {
			navRef.current = node;
			if (typeof forwardedRef === "function") forwardedRef(node);
			else if (forwardedRef) forwardedRef.current = node;
		},
		[forwardedRef],
	);

	const activeIndex = tags.findIndex((tag) => tag.name === activeTag);
	const activateTag = useCallback(
		(tag: SidebarTag) => onSelect(tag.name),
		[onSelect],
	);

	const { focusedIndex, onKeyDown } = useSidebarKeyboardNav({
		items: tags as SidebarTag[],
		onSelect: activateTag,
		navRef,
		activeIndex,
	});

	const virtualRows = useVirtualSidebarRows({
		rows: tags as SidebarTag[],
		scrollRef: navRef,
	});

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div
				ref={setNavRef}
				role="listbox"
				aria-label="Tags"
				className="flex-1 overflow-y-auto overscroll-contain px-1.5 py-1 outline-none"
				tabIndex={0}
				onKeyDown={onKeyDown}
			>
				{tags.length === 0
					? (emptyState ?? (
							<p className="px-2 py-3 text-[11px] text-muted-foreground">
								No tags yet.
							</p>
						))
					: null}
				{virtualRows.paddingTop > 0 ? (
					<div aria-hidden="true" style={{ height: virtualRows.paddingTop }} />
				) : null}
				{virtualRows.items.map(({ row: tag, index }) => {
					const isActive = tag.name === activeTag;
					const isFocused = focusedIndex === index;
					const label = formatLabel ? formatLabel(tag.name) : tag.name;
					return (
						<button
							key={tag.name}
							type="button"
							role="option"
							data-sidebar-index={index}
							aria-selected={isActive}
							title={label}
							className={cn(
								"flex w-full min-w-0 items-center gap-1.5 rounded-[var(--radius-row)] px-2 [padding-block:var(--row-pad-block)] text-start text-[length:var(--font-size-sidebar)] text-sidebar-foreground outline-hidden hover:bg-accent",
								!isActive && isFocused && "bg-accent",
								isActive &&
									"bg-sidebar-accent text-sidebar-accent-foreground font-medium",
							)}
							onClick={() => activateTag(tag)}
						>
							{renderIcon ? (
								<span className="flex shrink-0 items-center">
									{renderIcon(tag.name)}
								</span>
							) : null}
							<span className="min-w-0 flex-1 truncate">{label}</span>
							<span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
								{tag.count}
							</span>
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
		</div>
	);
};
