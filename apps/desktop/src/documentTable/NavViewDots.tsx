import type { MouseEvent as ReactMouseEvent, WheelEventHandler } from "react";
import { cn } from "../lib/utils";
import { NAV_VIEW_LABEL, NavViewIcon } from "./NavViewIcon";
import type { NavViewId, NavViewOption } from "./navHiddenViews";

/**
 * A12: the Rail-width view switcher. The sidebar pager's dot-tab language —
 * dot when inactive, icon when active or hovered — over the visible views,
 * with the pager's own wheel/swipe paging reused (not reimplemented).
 */
export function NavViewDots({
	views,
	active,
	onSelect,
	onToggleHidden,
	onWheel,
}: {
	/** Visible views, in dot order. Only rendered with more than one. */
	views: readonly NavViewId[];
	active: NavViewId;
	onSelect: (view: NavViewId) => void;
	onToggleHidden: (view: NavViewOption) => void;
	/** Swipe paging from `useNavViewSwitcher`, shared with the list region. */
	onWheel: WheelEventHandler<HTMLElement>;
}) {
	const onDotContextMenu = (
		event: ReactMouseEvent<HTMLElement>,
		view: NavViewId,
	) => {
		event.preventDefault();
		// Recent is the fallback view, so it has nothing to hide.
		if (view !== "recent") onToggleHidden(view);
	};

	return (
		<div
			data-nav-view-dots
			className="flex shrink-0 items-center justify-center gap-3 py-1"
			onWheel={onWheel}
		>
			{views.map((view) => {
				const isActive = active === view;
				return (
					<button
						key={view}
						type="button"
						data-nav-view-dot={view}
						aria-pressed={isActive}
						aria-label={`${NAV_VIEW_LABEL[view]} view`}
						title={
							view === "recent"
								? "Recent view"
								: `${NAV_VIEW_LABEL[view]} view — right-click to hide`
						}
						className={cn(
							"group relative flex size-5 items-center justify-center rounded-[var(--radius-row)] outline-hidden transition-all duration-200 ease-out focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none",
							isActive
								? "bg-selected text-selected-foreground"
								: "text-muted-foreground/60 hover:text-foreground",
						)}
						onClick={() => onSelect(view)}
						onContextMenu={(event) => onDotContextMenu(event, view)}
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
							<NavViewIcon view={view} />
						</span>
					</button>
				);
			})}
		</div>
	);
}
