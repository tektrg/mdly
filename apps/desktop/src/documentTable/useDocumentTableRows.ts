import { useStoreValue } from "@simplestack/store/react";
import { useMemo } from "react";
import { workspacePathStore, workspaceStore } from "../store/state";
import { documentTableViewStore } from "./documentTableStore";
import {
	applyDocumentTableView,
	buildDocumentRows,
	type DocumentTableRow,
	type DocumentTableView,
	withPropertyValues,
	workspaceFolderPaths,
} from "./documentTableView";
import {
	savedViewsStore,
	type WorkspaceSavedViews,
} from "./documentViewsFileStore";
import { groupByToViewId } from "./navHiddenViews";
import { useNavViewSort } from "./navViewSort";
import {
	type DocumentViewLayout,
	EMPTY_WORKSPACE_DOCUMENT_VIEWS,
	type SavedDocumentView,
	type WorkspaceDocumentViews,
} from "./properties/documentViews";
import type {
	PropertyField,
	PropertyFieldId,
} from "./properties/propertyFields";
import { usePropertyModel } from "./properties/usePropertyModel";

/** The open workspace's persisted views; a stable object when none are stored. */
export function useWorkspaceDocumentViews(): WorkspaceDocumentViews {
	const workspacePath = useStoreValue(workspacePathStore);
	const propertyColumns = useStoreValue(workspaceStore, (workspace) =>
		workspacePath
			? workspace.documentViews[workspacePath]?.propertyColumns
			: undefined,
	);
	const saved = useStoreValue(savedViewsStore, (all) =>
		workspacePath ? all[workspacePath]?.views : undefined,
	);
	return useMemo(
		() =>
			propertyColumns === undefined && saved === undefined
				? EMPTY_WORKSPACE_DOCUMENT_VIEWS
				: {
						propertyColumns:
							propertyColumns ?? EMPTY_WORKSPACE_DOCUMENT_VIEWS.propertyColumns,
						saved: saved ?? EMPTY_WORKSPACE_DOCUMENT_VIEWS.saved,
					},
		[propertyColumns, saved],
	);
}

/** The open workspace's saved-views file state (status, notice, save state). */
export function useWorkspaceSavedViewsState(): WorkspaceSavedViews | null {
	const workspacePath = useStoreValue(workspacePathStore);
	return (
		useStoreValue(savedViewsStore, (all) =>
			workspacePath ? all[workspacePath] : undefined,
		) ?? null
	);
}

export type CurrentDocumentView = {
	view: DocumentTableView;
	/** Visible property columns, in order, after the built-in columns. */
	propertyColumns: PropertyFieldId[];
	savedView: SavedDocumentView | null;
	/** Table, board or calendar, and the field the board/calendar reads. */
	layout: DocumentViewLayout;
	savedViews: SavedDocumentView[];
	propertyFields: PropertyField[];
};

/**
 * The view on screen: the session fields, with a saved view's sort, chips,
 * grouping and columns layered on while one is active (one source each, so a
 * saved view and the session can never both claim the chips).
 */
export function useCurrentDocumentView(): CurrentDocumentView {
	const session = useStoreValue(documentTableViewStore);
	const navSort = useNavViewSort(groupByToViewId(session.groupBy));
	const views = useWorkspaceDocumentViews();
	const { fields } = usePropertyModel();
	const savedView =
		views.saved.find((view) => view.id === session.activeSavedViewId) ?? null;
	const view = useMemo<DocumentTableView>(() => {
		const {
			activeSavedViewId: _unused,
			layout: _layout,
			...fieldsOfSession
		} = session;
		return savedView
			? {
					...fieldsOfSession,
					sort: savedView.sort,
					propertyFilters: savedView.filters,
					propertyGroupBy: savedView.groupBy,
				}
			: { ...fieldsOfSession, sort: navSort };
	}, [session, navSort, savedView]);
	return {
		view,
		propertyColumns: savedView
			? savedView.propertyColumns
			: views.propertyColumns,
		savedView,
		layout: savedView
			? {
					viewType: savedView.viewType,
					boardField: savedView.boardField,
					calendarField: savedView.calendarField,
					board: savedView.board,
				}
			: session.layout,
		savedViews: views.saved,
		propertyFields: fields,
	};
}

/**
 * The rows both densities render, from the listing the sidebar already holds
 * plus the background property scan. The view is the current one (see
 * `useCurrentDocumentView`), so consumers still receive one `DocumentTableView`.
 *
 * `buildDocumentRows` is memoized on the `files` array identity and the
 * property merge on the scan batch, so typing in the filter box re-runs
 * filter+sort only.
 */
export function useDocumentTableRows(activePath: string | null): {
	rows: DocumentTableRow[];
	view: DocumentTableView;
} {
	const files = useStoreValue(workspaceStore, (workspace) => workspace.files);
	const workspacePath = useStoreValue(workspacePathStore);
	const { view, propertyFields } = useCurrentDocumentView();
	const { valuesByPath, statsByPath } = usePropertyModel();
	const rows = useMemo(
		() =>
			applyDocumentTableView(
				withPropertyValues(
					buildDocumentRows(files, workspacePath ?? null),
					valuesByPath,
					statsByPath,
				),
				view,
				activePath,
				propertyFields,
			),
		[
			activePath,
			files,
			view,
			workspacePath,
			valuesByPath,
			statsByPath,
			propertyFields,
		],
	);
	return { rows, view };
}

/** The open workspace's folders (unfiltered), for the "+ Folder" picker. */
export function useWorkspaceFolderPaths(): string[] {
	const files = useStoreValue(workspaceStore, (workspace) => workspace.files);
	const workspacePath = useStoreValue(workspacePathStore);
	return useMemo(
		() => workspaceFolderPaths(buildDocumentRows(files, workspacePath ?? null)),
		[files, workspacePath],
	);
}
