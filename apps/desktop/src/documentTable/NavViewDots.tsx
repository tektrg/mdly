import { useSidebarSwipeNav } from "@mdly/workspace-kit";
import type { MouseEvent as ReactMouseEvent } from "react";
import MingcuteFolderLine from "~icons/mingcute/folder-line";
import MingcuteTagLine from "~icons/mingcute/tag-line";
import { cn } from "../lib/utils";
import type { NavGroupBy } from "./navGroupTree";
import type { NavViewOption } from "./navHiddenViews";

const DOT_LABEL: Record<NavViewOption, string> = {
	folder: "Folder view",
	tag: "Tag view",
};

function DotIcon({ view }: { view: NavViewOption }) {
	return view === "folder" ? (
		<MingcuteFolderLine aria-hidden="true" className="size-3.5" />
	) : (
		<MingcuteTagLine aria-hidden="true" className="size-3.5" />
	);
}

/**
 * A12: the Rail-width view switcher. The sidebar pager's dot-tab language —
 * dot when inactive, icon when active or hovered — over the two engine views,
 * with the pager's own wheel/swipe paging reused (not reimplemented).
 */
export function NavViewDots({
	views,
	active,
	onSelect,
	onToggleHidden,
}: {
	/** Visible views, in dot order. Never empty: a lone view shows no strip. */
	views: readonly NavViewOption[];
	active: NavGroupBy;
	onSelect: (view: NavViewOption) => void;
	onToggleHidden: (view: NavViewOption) => void;
}) {
	const activePage = active === null ? -1 : views.indexOf(active);
	const { onWheel } = useSidebarSwipeNav({
		activePage,
		pageCount: views.length,
		onPageChange: (page) => {
			const view = views[page];
			if (view !== undefined) onSelect(view);
		},
	});

	const onDotContextMenu = (
		event: ReactMouseEvent<HTMLElement>,
		view: NavViewOption,
	) => {
		event.preventDefault();
		onToggleHidden(view);
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
						aria-label={DOT_LABEL[view]}
						title={`${DOT_LABEL[view]} — right-click to hide`}
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
							<DotIcon view={view} />
						</span>
					</button>
				);
			})}
		</div>
	);
}
