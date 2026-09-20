import { useStoreValue } from "@simplestack/store/react";
import { workspacePathStore, workspaceStore } from "../store/state";
import {
	DEFAULT_NAV_VIEW_SORT,
	type DocumentTableSort,
} from "./documentTableView";
import type { NavViewId } from "./navHiddenViews";

/**
 * Per-view sort, per workspace. Same store, middleware and per-workspace-map
 * shape as `navHiddenViews.ts`; `serialize` carries it. It is the single source
 * of truth for sort — the session view store holds none, so there is no second
 * copy to drift.
 */
export function getNavViewSort(
	workspacePath: string | null,
	view: NavViewId,
): DocumentTableSort {
	if (!workspacePath) return DEFAULT_NAV_VIEW_SORT;
	return (
		workspaceStore.get().navViewSorts[workspacePath]?.[view] ??
		DEFAULT_NAV_VIEW_SORT
	);
}

export function setNavViewSort(
	workspacePath: string | null,
	view: NavViewId,
	sort: DocumentTableSort,
): void {
	if (!workspacePath) return;
	workspaceStore.set((state) => ({
		...state,
		navViewSorts: {
			...state.navViewSorts,
			[workspacePath]: { ...state.navViewSorts[workspacePath], [view]: sort },
		},
	}));
}

/** Reactive form of `getNavViewSort` for the workspace that is open now. */
export function useNavViewSort(view: NavViewId): DocumentTableSort {
	const workspacePath = useStoreValue(workspacePathStore);
	// Selecting the stored object (or undefined) keeps the snapshot stable; the
	// default is applied after, never created inside the selector.
	const stored = useStoreValue(workspaceStore, (workspace) =>
		workspacePath ? workspace.navViewSorts[workspacePath]?.[view] : undefined,
	);
	return stored ?? DEFAULT_NAV_VIEW_SORT;
}

/** Plain-English name of a sort, for tooltips. */
export function describeNavViewSort(sort: DocumentTableSort): string {
	if (sort.column !== "modified") return sort.column;
	return sort.direction === "desc" ? "recent" : "oldest";
}
