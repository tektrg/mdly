import { store } from "@simplestack/store";
import { workspacePathStore } from "../store/state";
import {
	createDefaultDocumentTableView,
	type DocumentTableColumn,
	type DocumentTableView,
	toggleSort,
} from "./documentTableView";

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

export function resetDocumentTableView() {
	documentTableViewStore.set(createDefaultDocumentTableView());
}

// A filter typed in one workspace must not survive into the next one, where it
// means nothing. Same subscription precedent as docNavigationHistory.ts.
workspacePathStore.subscribe(() => {
	resetDocumentTableView();
});
