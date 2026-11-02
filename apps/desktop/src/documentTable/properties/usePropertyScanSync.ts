import { useStoreValue } from "@simplestack/store/react";
import { useEffect } from "react";
import { desktopApi } from "../../desktopApi";
import { hasMarkdownExtension } from "../../lib/filePath";
import type { FileEntry } from "../../store/state";
import { workspacePathStore, workspaceStore } from "../../store/state";
import { useCurrentDocumentView } from "../useDocumentTableRows";
import { viewUsesFileStats } from "./builtinFields";
import { isPropertyValueFilter } from "./documentViews";
import { runPropertyScan } from "./propertyScanStore";

/** Watcher bursts (a git checkout, a sync) settle before the diff runs. */
const SCAN_DEBOUNCE_MS = 300;

function scanFilesOf(files: readonly FileEntry[]) {
	return files
		.filter((file) => hasMarkdownExtension(file.path))
		.map((file) => ({ path: file.path, modifiedAt: file.modified_at }));
}

/** True while the view on screen reads Word count or Size (whole-file reads). */
function useViewNeedsFileStats(): boolean {
	const { view, propertyColumns } = useCurrentDocumentView();
	return viewUsesFileStats({
		propertyColumns,
		sortColumn: view.sort.column,
		filterFieldIds: view.propertyFilters
			.filter(isPropertyValueFilter)
			.map((filter) => filter.fieldId),
		groupBy: view.propertyGroupBy,
	});
}

/**
 * Keeps the property scan in step with the listing. Mounted once by the host
 * of the document surfaces. Each listing change re-diffs by mtime, so an
 * unchanged refocus reads zero heads. The first time the view uses Word count
 * or Size, every file is read whole once; after that only changed files.
 */
export function usePropertyScanSync() {
	const files = useStoreValue(workspaceStore, (workspace) => workspace.files);
	const hasListedOnce = useStoreValue(
		workspaceStore,
		(workspace) => workspace.hasListedOnce,
	);
	const workspacePath = useStoreValue(workspacePathStore) ?? null;
	const needsFileStats = useViewNeedsFileStats();
	useEffect(() => {
		if (!workspacePath || !hasListedOnce) return;
		const timer = setTimeout(() => {
			void runPropertyScan(
				workspacePath,
				scanFilesOf(files),
				(paths, options) =>
					desktopApi.scanFrontMatterProperties(paths, options),
				{ includeStats: needsFileStats },
			);
		}, SCAN_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [files, hasListedOnce, workspacePath, needsFileStats]);
}
