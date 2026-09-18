import { Button } from "@hubble.md/ui";
import { useStoreValue } from "@simplestack/store/react";
import MingcuteAzSortAscendingLettersLine from "~icons/mingcute/az-sort-ascending-letters-line";
import MingcuteFolderLine from "~icons/mingcute/folder-line";
import MingcuteSortDescendingLine from "~icons/mingcute/sort-descending-line";
import MingcuteTagLine from "~icons/mingcute/tag-line";
import { cn } from "../lib/utils";
import { setSortMode } from "../store/actions";
import { workspacePathStore, workspaceStore } from "../store/state";
import {
	documentTableViewStore,
	setDocumentTableGroupBy,
} from "./documentTableStore";
import { NavViewDots } from "./NavViewDots";
import type { NavDensityTier } from "./navDensity";
import {
	NAV_VIEW_OPTIONS,
	type NavViewOption,
	setNavHiddenViewToggled,
} from "./navHiddenViews";

/** Stable empty for the hidden-views selector (see below). */
const NO_HIDDEN_VIEWS: NavViewOption[] = [];

const VIEW_LABEL: Record<NavViewOption, string> = {
	folder: "Folder",
	tag: "Tag",
};

function ViewIcon({ view }: { view: NavViewOption }) {
	return view === "folder" ? (
		<MingcuteFolderLine aria-hidden="true" className="size-3.5" />
	) : (
		<MingcuteTagLine aria-hidden="true" className="size-3.5" />
	);
}

/**
 * The strip above the list, at every density tier. Home of the sort control
 * since it moved out of the sidebar, plus the view switcher: an inline
 * two-option control everywhere except Rail, where A12 collapses it to the
 * sidebar pager's dot-tab strip (2 dots, folder + tag — search and Pinned
 * are never dots).
 */
export function NavListHeader({
	navTier = "table",
}: {
	navTier?: NavDensityTier;
}) {
	const sortMode = useStoreValue(
		workspaceStore,
		(workspace) => workspace.sortMode,
	);
	const groupBy = useStoreValue(documentTableViewStore, (view) => view.groupBy);
	const workspacePath = useStoreValue(workspacePathStore);
	// The fallback is a module constant, not a literal: the selector must
	// return a stable reference or the external-store snapshot never settles.
	const hidden = useStoreValue(workspaceStore, (workspace) =>
		workspacePath
			? (workspace.navHiddenViews[workspacePath] ?? NO_HIDDEN_VIEWS)
			: NO_HIDDEN_VIEWS,
	);
	const sortNext = sortMode === "alpha" ? "recent" : "alpha";
	const visible = NAV_VIEW_OPTIONS.filter((option) => !hidden.includes(option));

	const selectView = (view: NavViewOption) => {
		setDocumentTableGroupBy(groupBy === view ? null : view);
	};

	const toggleHidden = (view: NavViewOption) => {
		const next = setNavHiddenViewToggled(workspacePath ?? null, view);
		if (next === null) return;
		// Hiding the active view falls back to the first remaining one, so the
		// list can never sit on a hidden view. Anything else stays put.
		if (next.includes(view) && groupBy === view) {
			const fallback = NAV_VIEW_OPTIONS.find(
				(option) => !next.includes(option),
			);
			if (fallback !== undefined) setDocumentTableGroupBy(fallback);
		}
	};

	const selectInline = (view: NavViewOption) => {
		// A hidden view is restored by selecting it at a wider tier — the Rail
		// strip has no room for a restore target of its own.
		if (hidden.includes(view))
			setNavHiddenViewToggled(workspacePath ?? null, view);
		selectView(view);
	};

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
					active={groupBy}
					onSelect={selectView}
					onToggleHidden={toggleHidden}
				/>
			) : !isRail ? (
				<div
					data-nav-view-switcher
					className="flex shrink-0 items-center gap-1"
				>
					{NAV_VIEW_OPTIONS.map((option) => {
						const isActive: boolean = groupBy === option;
						const isHidden = hidden.includes(option);
						return (
							<button
								key={option}
								type="button"
								data-nav-view-option={option}
								aria-pressed={isActive}
								aria-label={`${VIEW_LABEL[option]} view`}
								title={
									isHidden
										? `${VIEW_LABEL[option]} view (hidden from Rail — select to restore)`
										: `${VIEW_LABEL[option]} view — right-click to hide`
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
									toggleHidden(option);
								}}
							>
								<ViewIcon view={option} />
								<span className="min-w-0 truncate">{VIEW_LABEL[option]}</span>
							</button>
						);
					})}
				</div>
			) : null}
			<Button
				variant="ghost"
				size="icon-xs"
				aria-label="Sort documents"
				aria-pressed={sortMode === "alpha"}
				title={`Sorted by ${sortMode === "alpha" ? "name" : "recent"} — select to sort by ${sortNext === "alpha" ? "name" : "recent"}`}
				onClick={() => setSortMode(sortNext)}
			>
				{sortMode === "alpha" ? (
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
