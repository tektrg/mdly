import { workspaceStore } from "../store/state";
import {
	dropOldest,
	NAV_GROUP_MAX_SCOPES_PER_WORKSPACE,
	NAV_GROUP_MAX_WORKSPACES,
	touch,
} from "./navExpandedGroups";

/**
 * The search box's (Cmd+L) text, remembered per workspace AND per view, across
 * restarts. Stored locally (the `workspaceStore` localStorage middleware, like
 * `navExpandedGroups.ts`), never in `.hubble/views.json`: what one person typed
 * on one machine is not part of the shared view definition.
 *
 * Shape: workspace → view key (`recent` | `folder` | `tag` | `saved:<id>`) →
 * text. Empty text is stored as "no entry". Same caps as group collapse state.
 */
export type NavViewFilters = Record<string, Record<string, string>>;

/** Longest text kept; anything longer is truncated on write and on load. */
export const NAV_VIEW_FILTER_MAX_LENGTH = 1000;

const SAVED_PREFIX = "saved:";

export function navFilterViewKey(
	activeSavedViewId: string | null,
	navViewId: string,
): string {
	return activeSavedViewId ? `${SAVED_PREFIX}${activeSavedViewId}` : navViewId;
}

export function getNavViewFilter(
	workspacePath: string | null,
	viewKey: string,
): string {
	if (!workspacePath) return "";
	return workspaceStore.get().navViewFilters[workspacePath]?.[viewKey] ?? "";
}

export function setNavViewFilter(
	workspacePath: string | null,
	viewKey: string,
	text: string,
): void {
	if (!workspacePath) return;
	const value = text.slice(0, NAV_VIEW_FILTER_MAX_LENGTH);
	if (getNavViewFilter(workspacePath, viewKey) === value) return;
	workspaceStore.set((state) => {
		const all = state.navViewFilters;
		const { [viewKey]: _old, ...rest } = all[workspacePath] ?? {};
		const views = value
			? dropOldest(
					touch(rest, viewKey, value),
					NAV_GROUP_MAX_SCOPES_PER_WORKSPACE,
				)
			: rest;
		return {
			...state,
			navViewFilters: dropOldest(
				touch(all, workspacePath, views),
				NAV_GROUP_MAX_WORKSPACES,
			),
		};
	});
}

/** Drops the text of saved views that no longer exist in the workspace. */
export function pruneDeletedSavedViewFilters(
	workspacePath: string,
	liveSavedViewIds: ReadonlySet<string>,
): void {
	const views = workspaceStore.get().navViewFilters[workspacePath];
	if (!views) return;
	const kept: Record<string, string> = {};
	let dropped = false;
	for (const [key, text] of Object.entries(views)) {
		if (
			key.startsWith(SAVED_PREFIX) &&
			!liveSavedViewIds.has(key.slice(SAVED_PREFIX.length))
		) {
			dropped = true;
			continue;
		}
		kept[key] = text;
	}
	if (!dropped) return;
	workspaceStore.set((state) => ({
		...state,
		navViewFilters: { ...state.navViewFilters, [workspacePath]: kept },
	}));
}
