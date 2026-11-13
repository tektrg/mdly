import { workspaceStore } from "../store/state";

/**
 * Group collapse/expand state, per workspace AND per view AND per grouping.
 *
 * Stored locally (the `workspaceStore` localStorage middleware, like
 * `peekListWidth.ts`), never in `.hubble/views.json`: that file is shared with
 * the CLI and agents, and collapse clicks are per-machine noise.
 *
 * Shape: workspace → scope key (`<view>|<grouping>`) → group id → expanded.
 * Only deviations from the default are kept, so a group never toggled — a new
 * tag, a renamed folder (new id) — renders with today's default. Keying on the
 * grouping too means a saved view regrouped from Tag to Folder starts clean;
 * its old Tag entries stay put (and come back if it is regrouped to Tag).
 */
export type NavGroupOverrides = Record<string, boolean>;
export type NavGroupExpansion = Record<
	string,
	Record<string, NavGroupOverrides>
>;

/** Caps: entries per scope, scopes per workspace, workspaces. Oldest go first. */
export const NAV_GROUP_MAX_IDS_PER_SCOPE = 500;
export const NAV_GROUP_MAX_SCOPES_PER_WORKSPACE = 64;
export const NAV_GROUP_MAX_WORKSPACES = 32;

const SAVED_PREFIX = "saved:";

/**
 * `view` is a switcher key: `recent` | `folder` | `tag` | `saved:<id>`.
 * `grouping` is what the rows are grouped on: `none`, `folder`, `tag`, or a
 * saved/session group-by (`group:folder`, `group:tag`, a property id, ...).
 */
export function navGroupScopeKey(view: string, grouping: string): string {
	return `${view}|${grouping}`;
}

const NO_OVERRIDES: NavGroupOverrides = Object.freeze({}) as NavGroupOverrides;

export function getNavGroupOverrides(
	workspacePath: string | null,
	scope: string,
): NavGroupOverrides {
	if (!workspacePath) return NO_OVERRIDES;
	return (
		workspaceStore.get().navGroupExpansion[workspacePath]?.[scope] ??
		NO_OVERRIDES
	);
}

/** Reads a group's state: its override when toggled, its default otherwise. */
export function isNavGroupExpanded(
	overrides: NavGroupOverrides,
	id: string,
	defaultExpanded: boolean,
): boolean {
	const value = overrides[id];
	return typeof value === "boolean" ? value : defaultExpanded;
}

function dropOldest<T>(record: Record<string, T>, max: number) {
	const keys = Object.keys(record);
	if (keys.length <= max) return record;
	const kept: Record<string, T> = {};
	for (const key of keys.slice(keys.length - max)) kept[key] = record[key] as T;
	return kept;
}

/** Moves `key` to the end (most recent) with `value`. */
function touch<T>(record: Record<string, T>, key: string, value: T) {
	const { [key]: _old, ...rest } = record;
	return { ...rest, [key]: value };
}

/**
 * Records groups' new states. A state equal to its default is stored as "no
 * override", so flipping back keeps the record small. No-ops without a
 * workspace.
 */
export function setNavGroupStates(
	workspacePath: string | null,
	scope: string,
	changes: readonly {
		id: string;
		expanded: boolean;
		defaultExpanded: boolean;
	}[],
): void {
	if (!workspacePath || changes.length === 0) return;
	workspaceStore.set((state) => {
		const all = state.navGroupExpansion;
		const scopes = all[workspacePath] ?? {};
		let overrides: NavGroupOverrides = { ...(scopes[scope] ?? {}) };
		for (const { id, expanded, defaultExpanded } of changes) {
			const { [id]: _old, ...rest } = overrides;
			overrides =
				expanded === defaultExpanded ? rest : { ...rest, [id]: expanded };
		}
		overrides = dropOldest(overrides, NAV_GROUP_MAX_IDS_PER_SCOPE);
		const nextScopes = dropOldest(
			touch(scopes, scope, overrides),
			NAV_GROUP_MAX_SCOPES_PER_WORKSPACE,
		);
		return {
			...state,
			navGroupExpansion: dropOldest(
				touch(all, workspacePath, nextScopes),
				NAV_GROUP_MAX_WORKSPACES,
			),
		};
	});
}

/** Drops every scope of a saved view that no longer exists in the workspace. */
export function pruneDeletedSavedViewGroups(
	workspacePath: string,
	liveSavedViewIds: ReadonlySet<string>,
): void {
	const scopes = workspaceStore.get().navGroupExpansion[workspacePath];
	if (!scopes) return;
	const kept: Record<string, NavGroupOverrides> = {};
	let dropped = false;
	for (const [scope, overrides] of Object.entries(scopes)) {
		const view = scope.slice(0, scope.indexOf("|"));
		if (
			view.startsWith(SAVED_PREFIX) &&
			!liveSavedViewIds.has(view.slice(SAVED_PREFIX.length))
		) {
			dropped = true;
			continue;
		}
		kept[scope] = overrides;
	}
	if (!dropped) return;
	workspaceStore.set((state) => ({
		...state,
		navGroupExpansion: { ...state.navGroupExpansion, [workspacePath]: kept },
	}));
}
