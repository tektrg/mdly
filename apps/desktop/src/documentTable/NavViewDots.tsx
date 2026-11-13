import type { MouseEvent as ReactMouseEvent, WheelEventHandler } from "react";
import { cn } from "../lib/utils";
import { NavEntryIcon, navEntryLabel } from "./NavViewIcon";
import type { NavViewOption } from "./navHiddenViews";
import type { NavSwitcherEntry, NavSwitcherKey } from "./navSwitcherEntries";

/**
 * A12: the Rail-width view switcher. The sidebar pager's dot-tab language —
 * dot when inactive, icon when active or hovered — over the visible views,
 * with the pager's own wheel/swipe paging reused (not reimplemented).
 */
export function NavViewDots({
	entries,
	active,
	onSelect,
	onToggleHidden,
	onSavedViewMenu,
	onWheel,
}: {
	/** Visible built-ins then saved views, in dot order. Only rendered with more than one. */
	entries: readonly NavSwitcherEntry[];
	active: NavSwitcherKey | null;
	onSelect: (entry: NavSwitcherEntry) => void;
	onToggleHidden: (view: NavViewOption) => void;
	/** Right-click on a saved-view dot: opens its Rename/Delete menu. */
	onSavedViewMenu: (id: string, anchor: HTMLElement) => void;
	/** Swipe paging from `useNavViewSwitcher`, shared with the list region. */
	onWheel: WheelEventHandler<HTMLElement>;
}) {
	const onDotContextMenu = (
		event: ReactMouseEvent<HTMLElement>,
		entry: NavSwitcherEntry,
	) => {
		event.preventDefault();
		if (entry.kind === "saved") {
			onSavedViewMenu(entry.id, event.currentTarget);
			return;
		}
		// Recent is the fallback view, so it has nothing to hide.
		if (entry.view !== "recent") onToggleHidden(entry.view);
	};

	return (
		<div
			data-nav-view-dots
			className="flex shrink-0 items-center justify-center gap-3 py-1"
			onWheel={onWheel}
		>
			{entries.map((entry) => {
				const isActive = active === entry.key;
				const label = navEntryLabel(entry);
				return (
					<button
						key={entry.key}
						type="button"
						data-nav-view-dot={entry.key}
						aria-pressed={isActive}
						aria-label={`${label} view`}
						title={
							entry.kind === "saved"
								? `${label} — right-click to rename, change icon or delete`
								: entry.view === "recent"
									? "Recent view"
									: `${label} view — right-click to hide`
						}
						className={cn(
							"group relative flex size-5 items-center justify-center rounded-mdly-control outline-hidden transition-all duration-200 ease-out focus-visible:ring-[3px] focus-visible:ring-mdly-ink/20 motion-reduce:transition-none",
							isActive
								? "bg-selected text-selected-foreground"
								: "text-muted-foreground/60 hover:text-foreground",
						)}
						onClick={() => onSelect(entry)}
						onContextMenu={(event) => onDotContextMenu(event, entry)}
					>
						<span
							aria-hidden="true"
							className={cn(
								"absolute size-1.5 rounded-full bg-current transition-all duration-200 ease-out motion-reduce:transition-none",
								isActive
									? "scale-0 opacity-0"
									: "scale-100 opacity-60 group-hover:scale-0 group-hover:opacity-0 group-focus-visible:scale-0 group-focus-visible:opacity-0",
							)}
						/>
						<span
							aria-hidden="true"
							className={cn(
								"flex items-center justify-center text-[13px] transition-all duration-200 ease-out motion-reduce:transition-none",
								isActive
									? "scale-100 opacity-100"
									: "pointer-events-none scale-50 opacity-0 group-hover:scale-100 group-hover:opacity-100 group-focus-visible:scale-100 group-focus-visible:opacity-100",
							)}
						>
							<NavEntryIcon entry={entry} />
						</span>
					</button>
				);
			})}
		</div>
	);
}
