import { Button } from "@hubble.md/ui";
import { useStoreValue } from "@simplestack/store/react";
import MingcuteAzSortAscendingLettersLine from "~icons/mingcute/az-sort-ascending-letters-line";
import MingcuteSortDescendingLine from "~icons/mingcute/sort-descending-line";
import { cn } from "../lib/utils";
import { workspacePathStore } from "../store/state";
import { DEFAULT_NAV_VIEW_SORT } from "./documentTableView";
import { NavViewDots } from "./NavViewDots";
import { NAV_VIEW_LABEL, NavViewIcon } from "./NavViewIcon";
import type { NavDensityTier } from "./navDensity";
import { NAV_VIEW_IDS } from "./navHiddenViews";
import {
	describeNavViewSort,
	setNavViewSort,
	useNavViewSort,
} from "./navViewSort";
import { useNavViewSwitcher } from "./useNavViewSwitcher";

/**
 * The strip above the list, at every density tier. Home of the sort control
 * since it moved out of the sidebar, plus the view switcher: inline buttons
 * (recent / folder / tag) everywhere except Rail, where A12 collapses it to the
 * sidebar pager's dot-tab strip — search and Pinned are never dots. The sort
 * control edits the current view's own persisted sort.
 */
export function NavListHeader({
	navTier = "table",
}: {
	navTier?: NavDensityTier;
}) {
	const workspacePath = useStoreValue(workspacePathStore) ?? null;
	const {
		activeView,
		hidden,
		visible,
		select,
		selectInline,
		toggleHidden,
		onWheel,
	} = useNavViewSwitcher();
	const sort = useNavViewSort(activeView);
	const isNameSort = sort.column === "name" && sort.direction === "asc";
	const sortNext = isNameSort ? "recent" : "name";

	const toggleSortMode = () =>
		setNavViewSort(
			workspacePath,
			activeView,
			isNameSort ? DEFAULT_NAV_VIEW_SORT : { column: "name", direction: "asc" },
		);

	const isRail = navTier === "rail";
	const showDots = isRail && visible.length > 1;

	return (
		<div
			data-nav-list-header
			className="flex shrink-0 items-center justify-between gap-1"
		>
			{showDots ? (
				<NavViewDots
					views={visible}
					active={activeView}
					onSelect={select}
					onToggleHidden={toggleHidden}
					onWheel={onWheel}
				/>
			) : !isRail ? (
				<div
					data-nav-view-switcher
					className="flex shrink-0 items-center gap-1"
					onWheel={onWheel}
				>
					{NAV_VIEW_IDS.map((option) => {
						const isActive = activeView === option;
						const isHidden = option !== "recent" && hidden.includes(option);
						return (
							<button
								key={option}
								type="button"
								data-nav-view-option={option}
								aria-pressed={isActive}
								aria-label={`${NAV_VIEW_LABEL[option]} view`}
								title={
									option === "recent"
										? "Recent view"
										: isHidden
											? `${NAV_VIEW_LABEL[option]} view (hidden from Rail — select to restore)`
											: `${NAV_VIEW_LABEL[option]} view — right-click to hide`
								}
								className={cn(
									"flex h-7 min-w-0 items-center gap-1 rounded-[var(--radius-row)] text-start text-[length:var(--font-size-sidebar)] outline-hidden transition-[background-color,color] duration-150 ease-snappy [padding-inline:var(--row-pad-inline)] hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none",
									isActive
										? "bg-selected font-medium text-selected-foreground"
										: "text-muted-foreground hover:text-foreground",
									isHidden && !isActive && "opacity-50",
								)}
								onClick={() => selectInline(option)}
								onContextMenu={(event) => {
									event.preventDefault();
									if (option !== "recent") toggleHidden(option);
								}}
							>
								<NavViewIcon view={option} />
								<span className="min-w-0 truncate">
									{NAV_VIEW_LABEL[option]}
								</span>
							</button>
						);
					})}
				</div>
			) : null}
			<Button
				variant="ghost"
				size="icon-xs"
				aria-label="Sort documents"
				aria-pressed={isNameSort}
				title={`Sorted by ${describeNavViewSort(sort)} — select to sort by ${sortNext}`}
				onClick={toggleSortMode}
			>
				{isNameSort ? (
					<MingcuteAzSortAscendingLettersLine
						aria-hidden="true"
						className="size-3.5"
					/>
				) : (
					<MingcuteSortDescendingLine aria-hidden="true" className="size-3.5" />
				)}
			</Button>
		</div>
	);
}
