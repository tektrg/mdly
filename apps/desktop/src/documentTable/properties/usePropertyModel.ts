import { useStoreValue } from "@simplestack/store/react";
import { useEffect } from "react";
import { desktopApi } from "../../desktopApi";
import { hasMarkdownExtension } from "../../lib/filePath";
import type { FileEntry } from "../../store/state";
import { workspacePathStore, workspaceStore } from "../../store/state";
import {
	derivePropertyModel,
	EMPTY_PROPERTY_MODEL,
	type PropertyModel,
} from "./propertyFields";
import {
	type PropertyScanState,
	propertyScanStore,
	runPropertyScan,
} from "./propertyScanStore";

/** The property model for the workspace open now; empty for any other scope. */
export function usePropertyModel(): PropertyModel {
	const workspacePath = useStoreValue(workspacePathStore) ?? null;
	const scan = useStoreValue(propertyScanStore);
	if (scan.scope !== workspacePath) return EMPTY_PROPERTY_MODEL;
	return derivePropertyModel(scan.propertiesByPath);
}

export function usePropertyScanState(): PropertyScanState {
	return useStoreValue(propertyScanStore);
}

/** Watcher bursts (a git checkout, a sync) settle before the diff runs. */
const SCAN_DEBOUNCE_MS = 300;

function scanFilesOf(files: readonly FileEntry[]) {
	return files
		.filter((file) => hasMarkdownExtension(file.path))
		.map((file) => ({ path: file.path, modifiedAt: file.modified_at }));
}

/**
 * Keeps the property scan in step with the listing. Mounted once by the host
 * of the document surfaces. Each listing change re-diffs by mtime, so an
 * unchanged refocus reads zero heads.
 */
export function usePropertyScanSync() {
	const files = useStoreValue(workspaceStore, (workspace) => workspace.files);
	const hasListedOnce = useStoreValue(
		workspaceStore,
		(workspace) => workspace.hasListedOnce,
	);
	const workspacePath = useStoreValue(workspacePathStore) ?? null;
	useEffect(() => {
		if (!workspacePath || !hasListedOnce) return;
		const timer = setTimeout(() => {
			void runPropertyScan(workspacePath, scanFilesOf(files), (paths) =>
				desktopApi.scanFrontMatterProperties(paths),
			);
		}, SCAN_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [files, hasListedOnce, workspacePath]);
}
