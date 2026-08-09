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
		<div className="flex shrink-0 items-center justify-center gap-4 py-1">
			{pages.map((page, index) => (
				<button
					key={page.id}
					type="button"
					aria-pressed={activePage === index}
					aria-label={page.label}
					title={page.label}
					className={cn(
						"flex size-3.5 items-center justify-center rounded-[var(--radius-row)] text-[8px] transition-colors",
						activePage === index
							? "bg-sidebar-accent text-sidebar-accent-foreground"
							: "text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground",
					)}
					onClick={() => onSelectPage(index)}
				>
					{page.icon}
				</button>
			))}
		</div>
	);
}
