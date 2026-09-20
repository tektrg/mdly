import { store } from "@simplestack/store";
import { workspacePathStore } from "../store/state";
import {
	createDefaultSessionView,
	type DocumentTableColumn,
	type DocumentTableSessionView,
	toggleSort,
} from "./documentTableView";
import type { NavGroupBy, NavViewMode } from "./navGroupTree";
import { groupByToViewId } from "./navHiddenViews";
import { getNavViewSort, setNavViewSort } from "./navViewSort";

/**
 * The session's document-table view (filter text, grouping, mode). Sort is not
 * here: it is persisted per nav view (`navViewSort.ts`) and composed in by
 * `useDocumentTableRows`.
 *
 * Declared **outside** `appStore` on purpose. `appStore` runs through
 * `localStoragePersist`, so filter text living there would be one whitelist edit
 * away from being persisted — and every keystroke would also land in the write
 * path the renderer-OOM storm detector instruments. Here there is no code path
 * to persistence at all: R-"filter is transient" holds by construction rather
 * than by review.
 */
export const documentTableViewStore = store<DocumentTableSessionView>(
	createDefaultSessionView(),
);

export function setDocumentTableFilter(filter: string) {
	documentTableViewStore.set((view) => ({ ...view, filter }));
}

/** Header-click sort: edits the current view's persisted sort only. */
export function toggleDocumentTableSort(column: DocumentTableColumn) {
	const workspacePath = workspacePathStore.get() ?? null;
	const view = groupByToViewId(documentTableViewStore.get().groupBy);
	setNavViewSort(
		workspacePath,
		view,
		toggleSort(getNavViewSort(workspacePath, view), column),
	);
}

/**
 * R2: switching between the flat list, folder view and tag view is a field on
 * the one view, not a different navigation surface.
 */
export function setDocumentTableGroupBy(groupBy: NavGroupBy) {
	documentTableViewStore.set((view) => ({ ...view, groupBy }));
}

/** A7: the mode the query is read in. Grouping and pinning follow from it. */
export function setDocumentTableMode(mode: NavViewMode) {
	documentTableViewStore.set((view) => ({ ...view, mode }));
}

export function resetDocumentTableView() {
	documentTableViewStore.set(createDefaultSessionView());
}

// A filter typed in one workspace must not survive into the next one, where it
// means nothing. Same subscription precedent as docNavigationHistory.ts.
//
// The grouping and mode added for the navigation views ride the same reset on
// purpose (defect 4, EC-72): the view resets on a workspace switch exactly as
// the sidebar's active page did, and survives no relaunch. One store owns it,
// so there is no second copy to reset in a different order.
workspacePathStore.subscribe(() => {
	resetDocumentTableView();
});
