import { store } from "@simplestack/store";
import { workspacePathStore, workspaceStore } from "../store/state";
import {
	createDefaultSessionView,
	type DocumentTableSessionView,
	type DocumentTableSort,
	type DocumentTableSortColumn,
	toggleSort,
} from "./documentTableView";
import type { NavGroupBy, NavViewMode } from "./navGroupTree";
import { groupByToViewId } from "./navHiddenViews";
import { getNavViewSort, setNavViewSort } from "./navViewSort";
import {
	EMPTY_WORKSPACE_DOCUMENT_VIEWS,
	MAX_SAVED_VIEW_NAME_LENGTH,
	type PropertyFilter,
	type SavedDocumentView,
	sameFilter,
	type WorkspaceDocumentViews,
} from "./properties/documentViews";
import type { PropertyFieldId } from "./properties/propertyFields";

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

// --- saved views (design note phase 3) -----------------------------------
//
// One rule for every edit below: while a saved view is active the edit is
// written INTO that view (it persists, Notion-style); otherwise it lands on the
// unsaved "All documents" view — chips and grouping for the session only,
// columns and sort persisted as before. "Save view" snapshots the current one.

function currentWorkspacePath(): string | null {
	return workspacePathStore.get() ?? null;
}

export function getWorkspaceDocumentViews(
	workspacePath: string | null,
): WorkspaceDocumentViews {
	if (!workspacePath) return EMPTY_WORKSPACE_DOCUMENT_VIEWS;
	return (
		workspaceStore.get().documentViews[workspacePath] ??
		EMPTY_WORKSPACE_DOCUMENT_VIEWS
	);
}

function writeWorkspaceDocumentViews(
	workspacePath: string,
	update: (views: WorkspaceDocumentViews) => WorkspaceDocumentViews,
) {
	workspaceStore.set((state) => ({
		...state,
		documentViews: {
			...state.documentViews,
			[workspacePath]: update(
				state.documentViews[workspacePath] ?? EMPTY_WORKSPACE_DOCUMENT_VIEWS,
			),
		},
	}));
}

/** The saved view the session is showing, or null (also when it was deleted). */
export function getActiveSavedView(): SavedDocumentView | null {
	const id = documentTableViewStore.get().activeSavedViewId;
	if (!id) return null;
	return (
		getWorkspaceDocumentViews(currentWorkspacePath()).saved.find(
			(view) => view.id === id,
		) ?? null
	);
}

type ViewEdit = Partial<
	Pick<SavedDocumentView, "sort" | "filters" | "groupBy" | "propertyColumns">
>;

function editCurrentView(edit: ViewEdit) {
	const workspacePath = currentWorkspacePath();
	const saved = getActiveSavedView();
	if (saved && workspacePath) {
		writeWorkspaceDocumentViews(workspacePath, (views) => ({
			...views,
			saved: views.saved.map((view) =>
				view.id === saved.id ? { ...view, ...edit } : view,
			),
		}));
		return;
	}
	if (edit.filters !== undefined || edit.groupBy !== undefined) {
		documentTableViewStore.set((view) => ({
			...view,
			...(edit.filters !== undefined ? { propertyFilters: edit.filters } : {}),
			...(edit.groupBy !== undefined
				? { propertyGroupBy: edit.groupBy, groupBy: null }
				: {}),
		}));
	}
	if (edit.propertyColumns !== undefined && workspacePath) {
		const propertyColumns = edit.propertyColumns;
		writeWorkspaceDocumentViews(workspacePath, (views) => ({
			...views,
			propertyColumns,
		}));
	}
	if (edit.sort !== undefined) {
		setNavViewSort(
			workspacePath,
			groupByToViewId(documentTableViewStore.get().groupBy),
			edit.sort,
		);
	}
}

/** The current view's sort, saved view first. */
export function getCurrentViewSort(): DocumentTableSort {
	return (
		getActiveSavedView()?.sort ??
		getNavViewSort(
			currentWorkspacePath(),
			groupByToViewId(documentTableViewStore.get().groupBy),
		)
	);
}

function getCurrentPropertyFilters(): PropertyFilter[] {
	return (
		getActiveSavedView()?.filters ??
		documentTableViewStore.get().propertyFilters
	);
}

export function getCurrentPropertyColumns(): PropertyFieldId[] {
	return (
		getActiveSavedView()?.propertyColumns ??
		getWorkspaceDocumentViews(currentWorkspacePath()).propertyColumns
	);
}

/** Header-click sort: edits the current view's sort only. */
export function toggleDocumentTableSort(column: DocumentTableSortColumn) {
	editCurrentView({ sort: toggleSort(getCurrentViewSort(), column) });
}

export function setDocumentTableSort(sort: DocumentTableSort) {
	editCurrentView({ sort });
}

/** Adds a chip; the same chip twice is one chip. */
export function addPropertyFilter(filter: PropertyFilter) {
	const filters = getCurrentPropertyFilters();
	if (filters.some((existing) => sameFilter(existing, filter))) return;
	editCurrentView({ filters: [...filters, filter] });
}

export function removePropertyFilter(filter: PropertyFilter) {
	editCurrentView({
		filters: getCurrentPropertyFilters().filter(
			(existing) => !sameFilter(existing, filter),
		),
	});
}

export function setPropertyGroupBy(fieldId: PropertyFieldId | null) {
	editCurrentView({ groupBy: fieldId });
}

/** "Add a column" / "Hide column": toggles one property column, appended at the end. */
export function togglePropertyColumn(fieldId: PropertyFieldId) {
	const columns = getCurrentPropertyColumns();
	editCurrentView({
		propertyColumns: columns.includes(fieldId)
			? columns.filter((column) => column !== fieldId)
			: [...columns, fieldId],
	});
}

function newSavedViewId(): string {
	return typeof crypto !== "undefined" && "randomUUID" in crypto
		? crypto.randomUUID()
		: `view-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Snapshots the current view under `name` and switches to it. Returns its id. */
export function saveCurrentViewAs(name: string): string | null {
	const workspacePath = currentWorkspacePath();
	const trimmed = name.trim().slice(0, MAX_SAVED_VIEW_NAME_LENGTH);
	if (!workspacePath || trimmed.length === 0) return null;
	const session = documentTableViewStore.get();
	const saved = getActiveSavedView();
	const view: SavedDocumentView = {
		id: newSavedViewId(),
		name: trimmed,
		sort: getCurrentViewSort(),
		filters: [...getCurrentPropertyFilters()],
		groupBy: saved ? saved.groupBy : session.propertyGroupBy,
		propertyColumns: [...getCurrentPropertyColumns()],
	};
	writeWorkspaceDocumentViews(workspacePath, (views) => ({
		...views,
		saved: [...views.saved, view],
	}));
	documentTableViewStore.set((current) => ({
		...current,
		activeSavedViewId: view.id,
		groupBy: null,
	}));
	return view.id;
}

/** Shows a saved view, or (null) the unsaved "All documents" view. */
export function selectSavedView(id: string | null) {
	documentTableViewStore.set((view) => ({
		...view,
		activeSavedViewId: id,
		groupBy: null,
	}));
}

export function renameSavedView(id: string, name: string) {
	const workspacePath = currentWorkspacePath();
	const trimmed = name.trim().slice(0, MAX_SAVED_VIEW_NAME_LENGTH);
	if (!workspacePath || trimmed.length === 0) return;
	writeWorkspaceDocumentViews(workspacePath, (views) => ({
		...views,
		saved: views.saved.map((view) =>
			view.id === id ? { ...view, name: trimmed } : view,
		),
	}));
}

export function deleteSavedView(id: string) {
	const workspacePath = currentWorkspacePath();
	if (!workspacePath) return;
	writeWorkspaceDocumentViews(workspacePath, (views) => ({
		...views,
		saved: views.saved.filter((view) => view.id !== id),
	}));
	if (documentTableViewStore.get().activeSavedViewId === id) {
		selectSavedView(null);
	}
}

/**
 * R2: switching between the flat list, folder view and tag view is a field on
 * the one view, not a different navigation surface.
 */
export function setDocumentTableGroupBy(groupBy: NavGroupBy) {
	// Folder/tag views are the nav views, not saved views: switching to one
	// leaves the saved view and drops a property grouping (one grouping at a time).
	documentTableViewStore.set((view) =>
		groupBy === null
			? { ...view, groupBy }
			: { ...view, groupBy, propertyGroupBy: null, activeSavedViewId: null },
	);
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
