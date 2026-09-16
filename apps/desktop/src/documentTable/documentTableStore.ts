import { store } from "@simplestack/store";
import { workspacePathStore } from "../store/state";
import {
	createDefaultDocumentTableView,
	type DocumentTableColumn,
	type DocumentTableView,
	toggleSort,
} from "./documentTableView";
import type { NavGroupBy, NavViewMode } from "./navGroupTree";

/**
 * The session's document-table view (filter text + sort).
 *
 * Declared **outside** `appStore` on purpose. `appStore` runs through
 * `localStoragePersist`, so filter text living there would be one whitelist edit
 * away from being persisted — and every keystroke would also land in the write
 * path the renderer-OOM storm detector instruments. Here there is no code path
 * to persistence at all: R-"filter is transient" holds by construction rather
 * than by review.
 */
export const documentTableViewStore = store<DocumentTableView>(
	createDefaultDocumentTableView(),
);

export function setDocumentTableFilter(filter: string) {
	documentTableViewStore.set((view) => ({ ...view, filter }));
}

export function toggleDocumentTableSort(column: DocumentTableColumn) {
	documentTableViewStore.set((view) => ({
		...view,
		sort: toggleSort(view.sort, column),
	}));
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
	documentTableViewStore.set(createDefaultDocumentTableView());
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
