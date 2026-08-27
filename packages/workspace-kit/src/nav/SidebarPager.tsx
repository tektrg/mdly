import type { ReactNode, RefObject } from "react";
import { cn } from "../lib/utils";
import { useSidebarSwipeNav } from "./useSidebarSwipeNav";

export type SidebarPage = {
	/** Stable identifier, also emitted as `data-sidebar-page` for tests. */
	id: string;
	/** Accessible name for this page's tab. */
	label: string;
	/** Small glyph shown in the tab strip. */
	icon: ReactNode;
	/**
	 * Focused when the user switches to this page -- the row list for a list
	 * page, the query box for the Search page.
	 */
	navRef: RefObject<HTMLElement | null>;
	content: ReactNode;
};

/**
 * Horizontally-paged sidebar body: a tab strip of small icons above a swipeable
 * track. Page count is whatever `pages` contains -- the track width, pane
 * width, translate step, focus target and tab strip all derive from it, so
 * there is exactly one place to add a view.
 *
 * Panes stay mounted rather than being conditionally rendered, so per-page
 * scroll position and the tree's folder expansion survive a flip.
 */
export function SidebarPager({
	pages,
	activePage,
	onPageChange,
}: {
	pages: readonly SidebarPage[];
	activePage: number;
	onPageChange: (page: number) => void;
}) {
	const { onWheel } = useSidebarSwipeNav({
		activePage,
		pageCount: pages.length,
		onPageChange,
	});

	return (
		<>
			<SidebarPagerTabs
				pages={pages}
				activePage={activePage}
				onSelectPage={onPageChange}
			/>
			<div
				data-sidebar-swipe-region
				className="relative min-h-0 flex-1 overflow-hidden"
				onWheel={onWheel}
			>
				{/* The track stays the width of one page and each pane is pinned to
				    that same width, so a flip is a whole -100% step. Sizing the
				    track to N pages instead would make both the width and the
				    translate percentages of each other, which is easy to get
				    subtly wrong and hard to read. */}
				<div
					className="flex h-full transition-transform duration-200 ease-out"
					style={{ transform: `translateX(-${activePage * 100}%)` }}
				>
					{pages.map((page, index) => (
						<div
							key={page.id}
							data-sidebar-page={page.id}
							className="flex h-full min-h-0 flex-col overflow-hidden"
							style={{ flex: "0 0 100%" }}
							aria-hidden={activePage !== index}
							inert={activePage !== index ? true : undefined}
						>
							{page.content}
						</div>
					))}
				</div>
			</div>
		</>
	);
}

function SidebarPagerTabs({
	pages,
	activePage,
	onSelectPage,
}: {
	pages: readonly SidebarPage[];
	activePage: number;
	onSelectPage: (page: number) => void;
}) {
	return (
		<div className="flex shrink-0 items-center justify-center gap-3 py-1">
			{pages.map((page, index) => {
				const isActive = activePage === index;
				return (
					<button
						key={page.id}
						type="button"
						aria-pressed={isActive}
						aria-label={page.label}
						title={page.label}
						className={cn(
							"group relative flex size-5 items-center justify-center rounded-[var(--radius-row)] transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
							isActive
								? "bg-sidebar-accent text-sidebar-accent-foreground"
								: "text-muted-foreground/60 hover:text-foreground",
						)}
						onClick={() => onSelectPage(index)}
					>
						{/* Inactive state: dot (hides on hover/active) */}
						<span
							aria-hidden="true"
							className={cn(
								"absolute size-1.5 rounded-full bg-current transition-all duration-200 ease-out",
								isActive
									? "scale-0 opacity-0"
									: "scale-100 opacity-60 group-hover:scale-0 group-hover:opacity-0 group-focus-visible:scale-0 group-focus-visible:opacity-0",
							)}
						/>
						{/* Icon (shows on active, or on hover when inactive without background highlight) */}
						<span
							aria-hidden="true"
							className={cn(
								"flex items-center justify-center text-[13px] transition-all duration-200 ease-out",
								isActive
									? "scale-100 opacity-100"
									: "scale-50 opacity-0 pointer-events-none group-hover:scale-100 group-hover:opacity-100 group-focus-visible:scale-100 group-focus-visible:opacity-100",
							)}
						>
							{page.icon}
						</span>
					</button>
				);
			})}
		</div>
	);
}
