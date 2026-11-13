import { store } from "@simplestack/store";
import type { ViewNameResult } from "@tektrg/table-core";
import { workspacePathStore, workspaceStore } from "../store/state";
import {
	createDefaultSessionView,
	type DocumentTableSessionView,
	type DocumentTableSort,
	type DocumentTableSortColumn,
	toggleSort,
} from "./documentTableView";
import {
	getSavedViews,
	getWorkspaceSavedViews,
	savedViewsStore,
	updateSavedViews,
	validateSavedViewName,
} from "./documentViewsFileStore";
import type { NavGroupBy, NavViewMode } from "./navGroupTree";
import {
	groupByToViewId,
	type NavViewId,
	viewIdToGroupBy,
} from "./navHiddenViews";
import { getNavViewSort, setNavViewSort } from "./navViewSort";
import {
	type BoardViewSettings,
	type DocumentGroupBy,
	type DocumentViewLayout,
	type DocumentViewType,
	EMPTY_WORKSPACE_DOCUMENT_VIEWS,
	type PropertyFilter,
	type SavedDocumentView,
	sameFilter,
	type WorkspaceDocumentViews,
} from "./properties/documentViews";
import type { PropertyFieldId } from "./properties/propertyFields";
import { isSavedViewIconName } from "./savedViewIcons";

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

/**
 * The workspace's views: saved views from the views file store
 * (`documentViewsFileStore.ts`), the unsaved view's columns from localStorage.
 */
export function getWorkspaceDocumentViews(
	workspacePath: string | null,
): WorkspaceDocumentViews {
	if (!workspacePath) return EMPTY_WORKSPACE_DOCUMENT_VIEWS;
	return {
		propertyColumns:
			workspaceStore.get().documentViews[workspacePath]?.propertyColumns ??
			EMPTY_WORKSPACE_DOCUMENT_VIEWS.propertyColumns,
		saved: getSavedViews(workspacePath),
	};
}

/** Built-in ("All documents") view state only — never saved views (R12). */
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
	Pick<
		SavedDocumentView,
		| "sort"
		| "filters"
		| "groupBy"
		| "propertyColumns"
		| keyof DocumentViewLayout
	>
>;

const LAYOUT_KEYS: readonly (keyof DocumentViewLayout)[] = [
	"viewType",
	"boardField",
	"calendarField",
	"board",
];

function layoutEditOf(edit: ViewEdit): Partial<DocumentViewLayout> | null {
	const layoutEdit: Partial<DocumentViewLayout> = {};
	for (const key of LAYOUT_KEYS) {
		if (edit[key] !== undefined)
			Object.assign(layoutEdit, { [key]: edit[key] });
	}
	return Object.keys(layoutEdit).length > 0 ? layoutEdit : null;
}

function editCurrentView(edit: ViewEdit) {
	const workspacePath = currentWorkspacePath();
	const saved = getActiveSavedView();
	if (saved && workspacePath) {
		updateSavedViews(workspacePath, (views) =>
			views.map((view) => (view.id === saved.id ? { ...view, ...edit } : view)),
		);
		return;
	}
	const layoutEdit = layoutEditOf(edit);
	if (layoutEdit) {
		documentTableViewStore.set((view) => ({
			...view,
			layout: { ...view.layout, ...layoutEdit },
		}));
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

export function getCurrentViewLayout(): DocumentViewLayout {
	const saved = getActiveSavedView();
	if (!saved) return documentTableViewStore.get().layout;
	return {
		viewType: saved.viewType,
		boardField: saved.boardField,
		calendarField: saved.calendarField,
		board: saved.board,
	};
}

/** Table / Board / Calendar switcher: edits the current view (saved views persist it). */
export function setDocumentViewType(viewType: DocumentViewType) {
	editCurrentView({ viewType });
}

export function setBoardField(boardField: PropertyFieldId | null) {
	editCurrentView({ boardField });
}

/** Board columns/cards arrangement: edits the current view (saved views persist it). */
export function updateBoardSettings(
	update: (settings: BoardViewSettings) => BoardViewSettings,
) {
	editCurrentView({ board: update(getCurrentViewLayout().board) });
}

export function setCalendarField(calendarField: PropertyFieldId | null) {
	editCurrentView({ calendarField });
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

/** Swaps one chip for another in place (the folder chip's picker edit). */
export function replacePropertyFilter(
	previous: PropertyFilter,
	next: PropertyFilter,
) {
	const filters = getCurrentPropertyFilters().filter(
		(existing) =>
			!sameFilter(existing, previous) && !sameFilter(existing, next),
	);
	editCurrentView({ filters: [...filters, next] });
}

export function setPropertyGroupBy(fieldId: DocumentGroupBy | null) {
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

/**
 * Header drag / Alt+Arrow on a property column: reorders within the current
 * view's property columns (saved views persist it). Property columns stay
 * after the built-ins, so this never crosses into the global built-in order.
 */
export function movePropertyColumn(from: number, to: number) {
	const columns = getCurrentPropertyColumns();
	if (
		from === to ||
		from < 0 ||
		to < 0 ||
		from >= columns.length ||
		to >= columns.length
	) {
		return;
	}
	const next = [...columns];
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	editCurrentView({ propertyColumns: next });
}

function newSavedViewId(): string {
	return typeof crypto !== "undefined" && "randomUUID" in crypto
		? crypto.randomUUID()
		: `view-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Snapshots the current view under `name` and switches to it. Returns its id. */
export function saveCurrentViewAs(name: string): string | null {
	const workspacePath = currentWorkspacePath();
	if (!workspacePath) return null;
	const valid = validateSavedViewName(workspacePath, name);
	if (!valid.ok) return null;
	const trimmed = valid.name;
	const session = documentTableViewStore.get();
	const saved = getActiveSavedView();
	const view: SavedDocumentView = {
		id: newSavedViewId(),
		name: trimmed,
		sort: getCurrentViewSort(),
		filters: [...getCurrentPropertyFilters()],
		groupBy: saved ? saved.groupBy : session.propertyGroupBy,
		propertyColumns: [...getCurrentPropertyColumns()],
		...getCurrentViewLayout(),
	};
	updateSavedViews(workspacePath, (views) => [...views, view]);
	selectSavedView(view.id);
	return view.id;
}

/** R3: remembers (or forgets, null) the selected saved view for a workspace. */
function rememberSelectedSavedView(
	workspacePath: string | null,
	id: string | null,
) {
	if (!workspacePath) return;
	const current = workspaceStore.get().selectedSavedViews[workspacePath];
	if ((current ?? null) === id) return;
	workspaceStore.set((state) => {
		const { [workspacePath]: _dropped, ...rest } = state.selectedSavedViews;
		return {
			...state,
			selectedSavedViews: id ? { ...rest, [workspacePath]: id } : rest,
		};
	});
}

/** Shows a saved view, or (null) the unsaved Recent view. */
export function selectSavedView(id: string | null) {
	documentTableViewStore.set((view) => ({
		...view,
		activeSavedViewId: id,
		groupBy: null,
	}));
	rememberSelectedSavedView(currentWorkspacePath(), id);
}

/** View-switcher pick of a built-in (Recent / Folder / Tag): leaves any saved view. */
export function selectBuiltInView(view: NavViewId) {
	if (view === "recent") {
		selectSavedView(null);
		return;
	}
	setDocumentTableGroupBy(viewIdToGroupBy(view));
}

/**
 * Renames a saved view (R2: trimmed, non-empty, unique ignoring case, not a
 * built-in, length-capped). Returns why when refused; nothing is written then.
 */
export function renameSavedView(id: string, name: string): ViewNameResult {
	const workspacePath = currentWorkspacePath();
	const valid = validateSavedViewName(workspacePath, name, id);
	if (!workspacePath || !valid.ok) {
		return valid.ok ? { ok: false, reason: "empty" } : valid;
	}
	updateSavedViews(workspacePath, (views) =>
		views.some((view) => view.id === id)
			? views.map((view) =>
					view.id === id ? { ...view, name: valid.name } : view,
				)
			: views,
	);
	return valid;
}

/**
 * Sets a saved view's icon (a `savedViewIcons` name), or clears it (null) so
 * the view draws the default. Unknown names are refused (returns false).
 */
export function setSavedViewIcon(id: string, icon: string | null): boolean {
	const workspacePath = currentWorkspacePath();
	if (!workspacePath) return false;
	if (icon !== null && !isSavedViewIconName(icon)) return false;
	if (!getSavedViews(workspacePath).some((view) => view.id === id))
		return false;
	updateSavedViews(workspacePath, (views) =>
		views.map((view) => {
			if (view.id !== id) return view;
			const { icon: _old, ...rest } = view;
			return icon === null ? rest : { ...rest, icon };
		}),
	);
	return true;
}

/** Bumped on every delete so only the latest delete's undo can apply. */
let latestDeleteToken = 0;

/**
 * Deletes a saved view immediately. Returns an undo function (null when nothing
 * was deleted) that restores the same view at its original position and
 * re-selects it if it was active. Undo is a no-op (returns false) once a newer
 * delete happened, the workspace changed, or the view is already back.
 */
export function deleteSavedView(id: string): (() => boolean) | null {
	const workspacePath = currentWorkspacePath();
	if (!workspacePath) return null;
	const before = getSavedViews(workspacePath);
	const index = before.findIndex((view) => view.id === id);
	if (index === -1) return null;
	const view = before[index] as SavedDocumentView;
	const wasActive = documentTableViewStore.get().activeSavedViewId === id;
	updateSavedViews(workspacePath, (views) =>
		views.filter((candidate) => candidate.id !== id),
	);
	// R3: deleting the active view lands on Recent, never a blank selection.
	if (wasActive) {
		selectSavedView(null);
	} else if (workspaceStore.get().selectedSavedViews[workspacePath] === id) {
		rememberSelectedSavedView(workspacePath, null);
	}
	const token = ++latestDeleteToken;
	return () => {
		if (token !== latestDeleteToken) return false;
		if (currentWorkspacePath() !== workspacePath) return false;
		latestDeleteToken++;
		if (getSavedViews(workspacePath).some((v) => v.id === id)) return false;
		updateSavedViews(workspacePath, (views) => {
			const next = [...views];
			next.splice(Math.min(index, next.length), 0, view);
			return next;
		});
		if (wasActive) selectSavedView(id);
		return true;
	};
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
	if (groupBy !== null) rememberSelectedSavedView(currentWorkspacePath(), null);
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
/** R3: a workspace opens on its remembered saved view (if any). */
function restoreSelectedSavedView() {
	const workspacePath = currentWorkspacePath();
	const id = workspacePath
		? (workspaceStore.get().selectedSavedViews[workspacePath] ?? null)
		: null;
	if (id) {
		documentTableViewStore.set((view) => ({
			...view,
			activeSavedViewId: id,
			groupBy: null,
		}));
	}
}

/**
 * R3: once the workspace's file has been read, a selected view that is not in
 * it falls back to Recent. Only a definite answer counts: while loading (the
 * built-ins-only first paint) or when the file is corrupt/unreadable, the
 * selection is kept — the view may still be there.
 */
function reconcileSelectedSavedView() {
	const workspacePath = currentWorkspacePath();
	const id = documentTableViewStore.get().activeSavedViewId;
	if (!workspacePath || !id) return;
	const { status, views } = getWorkspaceSavedViews(workspacePath);
	if (status !== "ok" && status !== "missing") return;
	if (views.some((view) => view.id === id)) return;
	selectSavedView(null);
}

workspacePathStore.subscribe(() => {
	resetDocumentTableView();
	restoreSelectedSavedView();
	reconcileSelectedSavedView();
});
restoreSelectedSavedView();
savedViewsStore.subscribe(() => reconcileSelectedSavedView());
