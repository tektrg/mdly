import { forwardRef, type ReactNode, useCallback, useRef } from "react";
import { cn } from "../lib/utils";
import type { SidebarTag } from "./buildTagCounts";
import { useSidebarKeyboardNav } from "./useSidebarKeyboardNav";
import { useVirtualSidebarRows } from "./useVirtualSidebarRows";

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
 * Forwards a ref to its scrollable/keyboard-navigable container so the pager
 * can move focus here when the user switches to this page.
 */
export const TagList = forwardRef<
	HTMLDivElement,
	{
		tags: readonly SidebarTag[];
		activeTag: string | null;
		onSelect: (name: string) => void;
		/** Per-row leading glyph, e.g. a host's own colored tag badge. */
		renderIcon?: (name: string) => ReactNode;
		/** Row label, when the host writes tags differently (e.g. a `#` prefix). */
		formatLabel?: (name: string) => string;
		emptyState?: ReactNode;
	}
>(function TagList(
	{ tags, activeTag, onSelect, renderIcon, formatLabel, emptyState },
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
});
