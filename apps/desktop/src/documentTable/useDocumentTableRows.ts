import { useStoreValue } from "@simplestack/store/react";
import { useMemo } from "react";
import { workspacePathStore, workspaceStore } from "../store/state";
import { documentTableViewStore } from "./documentTableStore";
import {
	applyDocumentTableView,
	buildDocumentRows,
	type DocumentTableRow,
	type DocumentTableView,
} from "./documentTableView";

/**
 * The rows both densities render, from the listing the sidebar already holds.
 * Reads nothing from disk.
 *
 * `buildDocumentRows` is memoized on the `files` array identity, so the O(files)
 * projection re-runs only when `refreshFiles` replaces the listing — typing in
 * the filter box re-runs filter+sort only.
 */
export function useDocumentTableRows(activePath: string | null): {
	rows: DocumentTableRow[];
	view: DocumentTableView;
} {
	const files = useStoreValue(workspaceStore, (workspace) => workspace.files);
	const workspacePath = useStoreValue(workspacePathStore);
	const view = useStoreValue(documentTableViewStore);
	const rows = useMemo(
		() =>
			applyDocumentTableView(
				buildDocumentRows(files, workspacePath ?? null),
				view,
				activePath,
			),
		[activePath, files, view, workspacePath],
	);
	return { rows, view };
}
