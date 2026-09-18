import { workspaceStore } from "../store/state";

/**
 * R2: group expansion, per workspace. Same store, same middleware, same
 * per-workspace-map shape as `peekListWidth.ts` — `serialize` carries it, so
 * there is no second mechanism. Render-time merging with the fresh tree's
 * defaults stays the caller's job: this stores the SET.
 */

/** The stored set, or null when the workspace was never toggled. */
export function getNavExpandedIds(
	workspacePath: string | null,
): string[] | null {
	if (!workspacePath) return null;
	const stored = workspaceStore.get().navExpandedGroups[workspacePath];
	return Array.isArray(stored) ? [...stored] : null;
}

/** Persists the merged set after a toggle. No-ops without a workspace. */
export function setNavExpandedIds(
	workspacePath: string | null,
	ids: readonly string[],
): void {
	if (!workspacePath) return;
	workspaceStore.set((state) => ({
		...state,
		navExpandedGroups: {
			...state.navExpandedGroups,
			[workspacePath]: [...ids],
		},
	}));
}
