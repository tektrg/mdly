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
	coerceViewFilterValue,
	DEFAULT_BOARD_VIEW_SETTINGS,
	DEFAULT_SAVED_VIEW_LAYOUT,
	type FilterCondition,
	type FilterGroup,
	isSavedViewSortColumn,
	isSavedViewType,
	MAX_SAVED_VIEW_NAME_LENGTH,
	matchesFolderFilters as matchesFolderGroup,
	SAVED_VIEW_TYPES,
	type SavedView,
	type SavedViewFilter,
	type SavedViewFolderFilter,
	type SavedViewLayout,
	type SavedViewType,
	type SavedViewValueFilter,
	sanitizeBoardSettings,
	sanitizeSavedView as sanitizeCoreSavedView,
	sanitizeSavedViewSort,
	sanitizeViewFieldIds,
} from "@tektrg/table-core";
import { CompiledTextPattern, splitEntries } from "../../lib/textPattern";
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
export type PropertyValueFilter = SavedViewValueFilter;
export type FolderFilter = SavedViewFolderFilter;
/**
 * `path:` chip — a comma-separated TextPattern list (`memory/*, *spec*.md,
 * /regex/`) matched against `folder/sub/file.md`. mdly-only: persisted as the
 * record's top-level `pathFilters: string[]` (not inside `filters`), so
 * table-core's sanitizer and older app builds keep the record and the value.
 */
export type PathFilter = { kind: "path"; pattern: string };
export type PropertyFilter = SavedViewFilter | PathFilter;
export type DocumentViewType = SavedViewType;
export type DocumentViewLayout = SavedViewLayout;

/**
 * Non-property groupings of a saved view (mdly-only; persisted as the record's
 * top-level `groupByKind`, with `groupBy: null`): full folder path, first
 * folder segment, front-matter tag.
 */
export const PATH_GROUP_BY = {
	folder: "group:folder",
	topFolder: "group:topFolder",
	tag: "group:tag",
} as const;
export type PathGroupBy = (typeof PATH_GROUP_BY)[keyof typeof PATH_GROUP_BY];
export type DocumentGroupBy = PropertyFieldId | PathGroupBy;

const PATH_GROUP_BY_KINDS = Object.keys(
	PATH_GROUP_BY,
) as (keyof typeof PATH_GROUP_BY)[];

export function isPathGroupBy(value: unknown): value is PathGroupBy {
	return Object.values(PATH_GROUP_BY).includes(value as PathGroupBy);
}

/** The property field a grouping reads, or null for a path grouping. */
export function propertyGroupField(
	groupBy: DocumentGroupBy | null,
): PropertyFieldId | null {
	return groupBy === null || isPathGroupBy(groupBy) ? null : groupBy;
}

export type SavedDocumentView = Omit<SavedView, "filters" | "groupBy"> & {
	filters: PropertyFilter[];
	groupBy: DocumentGroupBy | null;
};
export type { BoardColumnColor, BoardViewSettings };
export {
	BOARD_COLUMN_COLORS,
	DEFAULT_BOARD_VIEW_SETTINGS,
	MAX_SAVED_VIEW_NAME_LENGTH,
	sanitizeBoardSettings,
};

/** table-core's sanitizer plus mdly's `pathFilters` / `groupByKind` keys. */
export function sanitizeSavedView(value: unknown): SavedDocumentView | null {
	const view = sanitizeCoreSavedView(value);
	if (!view) return null;
	const raw = value as Record<string, unknown>;
	const pathFilters: PathFilter[] = Array.isArray(raw.pathFilters)
		? raw.pathFilters
				.filter(
					(pattern): pattern is string =>
						typeof pattern === "string" && pattern.trim() !== "",
				)
				.map((pattern) => ({ kind: "path", pattern }))
		: [];
	const kind = PATH_GROUP_BY_KINDS.find((key) => key === raw.groupByKind);
	return {
		...view,
		filters: [...view.filters, ...pathFilters],
		groupBy: kind ? PATH_GROUP_BY[kind] : view.groupBy,
	};
}

/**
 * The view as a `views.json` record: path chips move to `pathFilters`, a path
 * grouping to `groupByKind`. Absent keys are `undefined`, so spreading this
 * over an older raw record clears them (JSON drops `undefined`).
 */
export function savedViewToRecord(
	view: SavedDocumentView,
): Record<string, unknown> {
	const pathFilters = view.filters
		.filter(isPathFilter)
		.map((filter) => filter.pattern);
	const kind = PATH_GROUP_BY_KINDS.find(
		(key) => PATH_GROUP_BY[key] === view.groupBy,
	);
	return {
		...view,
		filters: view.filters.filter((filter) => !isPathFilter(filter)),
		groupBy: kind ? null : view.groupBy,
		pathFilters: pathFilters.length > 0 ? pathFilters : undefined,
		groupByKind: kind,
	};
}

export function isPathFilter(filter: PropertyFilter): filter is PathFilter {
	return filter.kind === "path";
}
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
	return filter.kind === "has" || filter.kind === "is";
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
	if (a.kind === "path" || b.kind === "path") {
		return a.kind === "path" && b.kind === "path" && a.pattern === b.pattern;
	}
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
	if (filter.kind === "path") return `Path: ${filter.pattern}`;
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

const PATH_GROUP_LABELS: Record<PathGroupBy, string> = {
	"group:folder": "Folder",
	"group:topFolder": "Top-level folder",
	"group:tag": "Tag",
};

export function describeGroupBy(
	fieldId: DocumentGroupBy,
	fields: readonly PropertyField[],
): string {
	if (isPathGroupBy(fieldId)) return `Grouped by ${PATH_GROUP_LABELS[fieldId]}`;
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
		// CLI/MCP views store text ("true", "3"); match typed front matter too.
		value: type ? coerceViewFilterValue(filter.value, type) : filter.value,
	};
}

/**
 * All property (`has`/`is`) chips AND-ed into one engine filter; undefined
 * when there are none. `folder:` chips are not engine conditions — callers
 * AND the folder group (chips OR-ed together) in with `matchesFolderFilters` on every evaluation path.
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
 * True when the workspace-relative `docPath` is in ANY `folder:` chip (OR,
 * subfolders included; PO 2026-11-07). No folder chips → true. The shared
 * rule lives in table-core so the CLI/MCP and the app agree.
 */
export function matchesFolderFilters(
	docPath: string,
	filters: readonly PropertyFilter[],
): boolean {
	return matchesFolderGroup(docPath, filters as readonly SavedViewFilter[]);
}

/**
 * The view's `path:` chips as one compiled pattern (chips OR-ed, entries of a
 * chip OR-ed); null when there are none. Build once per filter set.
 */
export function compilePathFilters(
	filters: readonly PropertyFilter[],
): CompiledTextPattern | null {
	const entries = filters
		.filter(isPathFilter)
		.flatMap((filter) => splitEntries(filter.pattern));
	if (entries.length === 0) {
		return filters.some(isPathFilter) ? new CompiledTextPattern([]) : null;
	}
	return new CompiledTextPattern(entries);
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
