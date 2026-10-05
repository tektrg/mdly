import { useStoreValue } from "@simplestack/store/react";
import { workspacePathStore, workspaceStore } from "../../store/state";
import { buildDocumentRows } from "../documentTableView";
import {
	derivePropertyModel,
	EMPTY_PROPERTY_MODEL,
	type PropertyModel,
} from "./propertyFields";
import { type PropertyScanState, propertyScanStore } from "./propertyScanStore";

/**
 * The property model for the workspace open now (front matter + built-in
 * file properties); empty for any other scope.
 */
export function usePropertyModel(): PropertyModel {
	const workspacePath = useStoreValue(workspacePathStore) ?? null;
	const files = useStoreValue(workspaceStore, (workspace) => workspace.files);
	const scan = useStoreValue(propertyScanStore);
	if (scan.scope !== workspacePath) return EMPTY_PROPERTY_MODEL;
	// Memoized on the listing (the same projection the table renders).
	const rows = buildDocumentRows(files, workspacePath);
	return derivePropertyModel(scan.propertiesByPath, {
		rows,
		statsByPath: scan.statsByPath,
	});
}

export function usePropertyScanState(): PropertyScanState {
	return useStoreValue(propertyScanStore);
}
