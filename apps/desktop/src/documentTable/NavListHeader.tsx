import { Button } from "@hubble.md/ui";
import { useStoreValue } from "@simplestack/store/react";
import MingcuteAzSortAscendingLettersLine from "~icons/mingcute/az-sort-ascending-letters-line";
import MingcuteSortDescendingLine from "~icons/mingcute/sort-descending-line";
import { setSortMode } from "../store/actions";
import { workspaceStore } from "../store/state";

/**
 * The strip above the list, at every density tier. Home of the sort control
 * since it moved out of the sidebar: one toggle cycling the workspace's
 * alpha/recent order, bound to the same store as before.
 */
export function NavListHeader() {
	const sortMode = useStoreValue(
		workspaceStore,
		(workspace) => workspace.sortMode,
	);
	const next = sortMode === "alpha" ? "recent" : "alpha";

	return (
		<div
			data-nav-list-header
			className="flex shrink-0 items-center justify-end gap-1"
		>
			<Button
				variant="ghost"
				size="icon-xs"
				aria-label="Sort documents"
				aria-pressed={sortMode === "alpha"}
				title={`Sorted by ${sortMode === "alpha" ? "name" : "recent"} — select to sort by ${next === "alpha" ? "name" : "recent"}`}
				onClick={() => setSortMode(next)}
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
