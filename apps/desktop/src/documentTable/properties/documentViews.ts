/**
 * Property filters and saved views (design note phase 3) as plain data.
 *
 * Pure and store-free, so persistence can sanitize with it and the engine can
 * compile it without importing React or the stores.
 */
import {
	BOARD_COLUMN_COLORS,
	type BoardColumnColor,
	type BoardViewSettings,
	DEFAULT_BOARD_VIEW_SETTINGS,
	DEFAULT_SAVED_VIEW_LAYOUT,
	type FilterCondition,
	type FilterGroup,
	isSavedViewSortColumn,
	isSavedViewType,
	MAX_SAVED_VIEW_NAME_LENGTH,
	matchesFolder,
	SAVED_VIEW_TYPES,
	type SavedView,
	type SavedViewFilter,
	type SavedViewFolderFilter,
	type SavedViewLayout,
	type SavedViewType,
	type SavedViewValueFilter,
	sanitizeBoardSettings,
	sanitizeSavedView,
	sanitizeSavedViewSort,
	sanitizeViewFieldIds,
} from "@tektrg/table-core";
import {
	fallbackPropertyLabel,
	type PropertyField,
	type PropertyFieldId,
} from "./propertyFields";

/**
 * The saved-view record format (types, defaults, sanitizer) lives in
 * `@tektrg/table-core` (shared with the `hubble views` CLI and the MCP tools,
 * saved views outside the app R9). The aliases below keep mdly's names.
 *
 * Filter chips: `has` = carries a non-empty value; `is` = equals a value (has
 * the tag, for a multi-value field); `folder:<path>` = documents in that
 * workspace-relative folder or any subfolder (`matchesFolder`).
 */
export type PropertyFilter = SavedViewFilter;
export type PropertyValueFilter = SavedViewValueFilter;
export type FolderFilter = SavedViewFolderFilter;
export type DocumentViewType = SavedViewType;
export type DocumentViewLayout = SavedViewLayout;
export type SavedDocumentView = SavedView;
export type { BoardColumnColor, BoardViewSettings };
export {
	BOARD_COLUMN_COLORS,
	DEFAULT_BOARD_VIEW_SETTINGS,
	MAX_SAVED_VIEW_NAME_LENGTH,
	sanitizeBoardSettings,
	sanitizeSavedView,
};
export const DOCUMENT_VIEW_TYPES = SAVED_VIEW_TYPES;
export const DEFAULT_DOCUMENT_VIEW_LAYOUT = DEFAULT_SAVED_VIEW_LAYOUT;
export const isDocumentTableSortColumn = isSavedViewSortColumn;
export const sanitizeDocumentTableSort = sanitizeSavedViewSort;
export const isDocumentViewType = isSavedViewType;

export function isFolderFilter(filter: PropertyFilter): filter is FolderFilter {
	return filter.kind === "folder";
}

export function isPropertyValueFilter(
	filter: PropertyFilter,
): filter is PropertyValueFilter {
	return filter.kind !== "folder";
}

/** Per-workspace persisted views state. */
export type WorkspaceDocumentViews = {
	/** Property columns shown in the unsaved "All documents" view. */
	propertyColumns: PropertyFieldId[];
	saved: SavedDocumentView[];
};

export const EMPTY_WORKSPACE_DOCUMENT_VIEWS: WorkspaceDocumentViews = {
	propertyColumns: [],
	saved: [],
};

export function sameFilter(a: PropertyFilter, b: PropertyFilter): boolean {
	if (a.kind === "folder" || b.kind === "folder") {
		return a.kind === "folder" && b.kind === "folder" && a.path === b.path;
	}
	return (
		a.fieldId === b.fieldId &&
		a.kind === b.kind &&
		(a.kind === "has" || (b.kind === "is" && a.value === b.value))
	);
}

function fieldLabel(
	fieldId: PropertyFieldId,
	fields: readonly PropertyField[],
): string {
	return (
		fields.find((field) => field.id === fieldId)?.label ??
		fallbackPropertyLabel(fieldId)
	);
}

export function describePropertyFilter(
	filter: PropertyFilter,
	fields: readonly PropertyField[],
): string {
	if (filter.kind === "folder") return `Folder: ${filter.path}`;
	const label = fieldLabel(filter.fieldId, fields);
	if (filter.kind === "has") return `has ${label}`;
	const value =
		typeof filter.value === "boolean"
			? filter.value
				? "Yes"
				: "No"
			: String(filter.value);
	const field = fields.find((candidate) => candidate.id === filter.fieldId);
	return field?.type === "multiSelect"
		? `${label} has ${value}`
		: `${label} is ${value}`;
}

export function describeGroupBy(
	fieldId: PropertyFieldId,
	fields: readonly PropertyField[],
): string {
	return `Grouped by ${fieldLabel(fieldId, fields)}`;
}

function toCondition(
	filter: PropertyValueFilter,
	fields: readonly PropertyField[],
): FilterCondition {
	if (filter.kind === "has") {
		return {
			kind: "condition",
			fieldId: filter.fieldId,
			operator: "is_not_empty",
		};
	}
	const type = fields.find((field) => field.id === filter.fieldId)?.type;
	return {
		kind: "condition",
		fieldId: filter.fieldId,
		operator: type === "multiSelect" ? "contains" : "equals",
		value: filter.value,
	};
}

/**
 * All property (`has`/`is`) chips AND-ed into one engine filter; undefined
 * when there are none. `folder:` chips are not engine conditions — callers
 * AND them in with `matchesFolderFilters` on every evaluation path.
 */
export function propertyFiltersToFilterGroup(
	filters: readonly PropertyFilter[],
	fields: readonly PropertyField[],
): FilterGroup | undefined {
	const valueFilters = filters.filter(isPropertyValueFilter);
	if (valueFilters.length === 0) return undefined;
	return {
		kind: "group",
		combinator: "and",
		children: valueFilters.map((filter) => toCondition(filter, fields)),
	};
}

/**
 * True when the workspace-relative `docPath` satisfies every `folder:` chip
 * (AND). No folder chips → true.
 */
export function matchesFolderFilters(
	docPath: string,
	filters: readonly PropertyFilter[],
): boolean {
	for (const filter of filters) {
		if (filter.kind === "folder" && !matchesFolder(docPath, filter.path)) {
			return false;
		}
	}
	return true;
}

// --- sanitizing persisted JSON -------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Drops malformed entries; a workspace with nothing left is omitted. */
export function sanitizeDocumentViews(
	value: unknown,
): Record<string, WorkspaceDocumentViews> {
	if (!isRecord(value)) return {};
	const byWorkspace: Record<string, WorkspaceDocumentViews> = {};
	for (const [workspacePath, entry] of Object.entries(value)) {
		if (workspacePath === "__proto__" || !isRecord(entry)) continue;
		const seenIds = new Set<string>();
		const saved = (Array.isArray(entry.saved) ? entry.saved : [])
			.map(sanitizeSavedView)
			.filter((view): view is SavedDocumentView => {
				if (!view || seenIds.has(view.id)) return false;
				seenIds.add(view.id);
				return true;
			});
		const propertyColumns = sanitizeViewFieldIds(entry.propertyColumns);
		if (saved.length === 0 && propertyColumns.length === 0) continue;
		byWorkspace[workspacePath] = { propertyColumns, saved };
	}
	return byWorkspace;
}
