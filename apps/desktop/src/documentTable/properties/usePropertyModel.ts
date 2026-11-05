import { useShallow, useStoreValue } from "@simplestack/store/react";
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
	// Only the fields the model reads: progress ticks (`scannedCount`,
	// `pendingCount`) must not re-render every table/board consumer.
	const scan = useStoreValue(
		propertyScanStore,
		useShallow((state) => ({
			scope: state.scope,
			propertiesByPath: state.propertiesByPath,
			statsByPath: state.statsByPath,
		})),
	);
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

export function usePropertyScanStatus(): PropertyScanState["status"] {
	return useStoreValue(propertyScanStore, (state) => state.status);
}
