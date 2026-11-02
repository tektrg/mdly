import type { NavViewId } from "./navHiddenViews";
import type { SavedDocumentView } from "./properties/documentViews";

/** A saved view's key in the switcher; built-ins keep their bare id. */
export type SavedViewKey = `saved:${string}`;
export type NavSwitcherKey = NavViewId | SavedViewKey;

/**
 * One position in the view switcher (dots, inline buttons, swipe): the
 * built-ins first, then each saved view in file order (saved views R1).
 */
export type NavSwitcherEntry =
	| { key: NavViewId; kind: "builtin"; view: NavViewId }
	| { key: SavedViewKey; kind: "saved"; id: string; name: string };

export function savedViewKey(id: string): SavedViewKey {
	return `saved:${id}`;
}

export function builtInEntries(
	views: readonly NavViewId[],
): NavSwitcherEntry[] {
	return views.map((view) => ({ key: view, kind: "builtin", view }));
}

export function savedEntries(
	views: readonly SavedDocumentView[],
): NavSwitcherEntry[] {
	return views.map((view) => ({
		key: savedViewKey(view.id),
		kind: "saved",
		id: view.id,
		name: view.name,
	}));
}
