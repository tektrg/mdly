import { workspaceStore } from "../store/state";
import type { NavGroupBy } from "./navGroupTree";

/**
 * The swipeable views of the document list, in swipe order. `recent` is the
 * flat ungrouped list (`groupBy: null` in the engine); the other two are the
 * engine's group-by values. Search and Pinned are modes/sections, never views.
 */
export const NAV_VIEW_IDS = ["recent", "folder", "tag"] as const;

export type NavViewId = (typeof NAV_VIEW_IDS)[number];

export function viewIdToGroupBy(view: NavViewId): NavGroupBy {
	return view === "recent" ? null : view;
}

export function groupByToViewId(groupBy: NavGroupBy): NavViewId {
	return groupBy ?? "recent";
}

/**
 * A12: the views a workspace hides from the Rail dot strip. Same store, same
 * middleware, same per-workspace-map shape as `peekListWidth.ts` — `serialize`
 * carries it, so there is no second mechanism.
 *
 * `recent` is deliberately not hideable: it is the default and the fallback,
 * so the strip can never be empty.
 */
export const NAV_VIEW_OPTIONS = ["folder", "tag"] as const;

export type NavViewOption = (typeof NAV_VIEW_OPTIONS)[number];

function sanitizeViews(views: readonly unknown[]): NavViewOption[] {
	const kept = [...new Set(views)].filter(
		(view): view is NavViewOption => view === "folder" || view === "tag",
	);
	return NAV_VIEW_OPTIONS.filter((option) => kept.includes(option));
}

/** Hidden views for a workspace; empty (both dots) when never configured. */
export function getNavHiddenViews(
	workspacePath: string | null,
): NavViewOption[] {
	if (!workspacePath) return [];
	const stored = workspaceStore.get().navHiddenViews[workspacePath];
	return Array.isArray(stored) ? sanitizeViews(stored) : [];
}

function writeNavHiddenViews(
	workspacePath: string,
	views: readonly NavViewOption[],
): void {
	workspaceStore.set((state) => ({
		...state,
		navHiddenViews: { ...state.navHiddenViews, [workspacePath]: [...views] },
	}));
}

/** Pure toggle step: hiding returns the next hidden set, unhiding removes it. */
export function toggleHiddenView(
	hidden: readonly NavViewOption[],
	view: NavViewOption,
): NavViewOption[] {
	return hidden.includes(view)
		? hidden.filter((hiddenView) => hiddenView !== view)
		: [...hidden, view];
}

/** Persists a toggle; no-ops without a workspace. */
export function setNavHiddenViewToggled(
	workspacePath: string | null,
	view: NavViewOption,
): NavViewOption[] | null {
	if (!workspacePath) return null;
	const next = toggleHiddenView(getNavHiddenViews(workspacePath), view);
	writeNavHiddenViews(workspacePath, next);
	return next;
}
