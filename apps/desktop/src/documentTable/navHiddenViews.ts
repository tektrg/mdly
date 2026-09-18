import { workspaceStore } from "../store/state";

/**
 * A12: the views a workspace hides from the Rail dot strip. Same store, same
 * middleware, same per-workspace-map shape as `peekListWidth.ts` — `serialize`
 * carries it, so there is no second mechanism.
 *
 * Exactly the engine's two group-by values, in dot order. Search and Pinned
 * are modes/sections, never dots, so they can never appear here.
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

/**
 * Pure toggle step: hiding returns the next hidden set, unhiding removes it.
 * Returns null when hiding would leave zero visible views — the last visible
 * one is a no-op, never a crash and never an empty strip.
 */
export function toggleHiddenView(
	hidden: readonly NavViewOption[],
	view: NavViewOption,
): NavViewOption[] | null {
	if (hidden.includes(view)) {
		return hidden.filter((hiddenView) => hiddenView !== view);
	}
	if (
		NAV_VIEW_OPTIONS.every(
			(option) => option === view || hidden.includes(option),
		)
	) {
		return null;
	}
	return [...hidden, view];
}

/** Persists a toggle; no-ops without a workspace or on a last-visible hide. */
export function setNavHiddenViewToggled(
	workspacePath: string | null,
	view: NavViewOption,
): NavViewOption[] | null {
	if (!workspacePath) return null;
	const next = toggleHiddenView(getNavHiddenViews(workspacePath), view);
	if (next === null) return null;
	writeNavHiddenViews(workspacePath, next);
	return next;
}
