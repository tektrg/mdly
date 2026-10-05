/**
 * Property filters and saved views (design note phase 3) as plain data.
 *
 * Pure and store-free, so persistence can sanitize with it and the engine can
 * compile it without importing React or the stores.
 */
import type {
	FilterCondition,
	FilterGroup,
	ScalarValue,
} from "@tektrg/table-core";
import type { DocumentTableSort } from "../documentTableView";
import {
	fallbackPropertyLabel,
	isPropertyFieldId,
	type PropertyField,
	type PropertyFieldId,
} from "./propertyFields";

/**
 * One visible, deletable filter chip (decision E: never filter silently).
 * `has` = carries a non-empty value; `is` = equals a value (has the tag, for a
 * multi-value field).
 */
export type PropertyFilter =
	| { fieldId: PropertyFieldId; kind: "has" }
	| { fieldId: PropertyFieldId; kind: "is"; value: ScalarValue };

/** How a view lays its documents out. Views saved before step 5 are tables. */
export type DocumentViewType = "table" | "board" | "calendar";

export const DOCUMENT_VIEW_TYPES: readonly DocumentViewType[] = [
	"table",
	"board",
	"calendar",
];

/** The layout half of a view: its type and the field each layout reads. */
export type DocumentViewLayout = {
	viewType: DocumentViewType;
	/** Board columns come from this select field; null = the default (status). */
	boardField: PropertyFieldId | null;
	/** Calendar days come from this date field; null = the default (due). */
	calendarField: PropertyFieldId | null;
};

export const DEFAULT_DOCUMENT_VIEW_LAYOUT: DocumentViewLayout = {
	viewType: "table",
	boardField: null,
	calendarField: null,
};

export type SavedDocumentView = DocumentViewLayout & {
	id: string;
	name: string;
	sort: DocumentTableSort;
	filters: PropertyFilter[];
	groupBy: PropertyFieldId | null;
	propertyColumns: PropertyFieldId[];
};

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

export const MAX_SAVED_VIEW_NAME_LENGTH = 60;

export function sameFilter(a: PropertyFilter, b: PropertyFilter): boolean {
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
	filter: PropertyFilter,
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

/** All chips AND-ed into one engine filter; undefined when there are none. */
export function propertyFiltersToFilterGroup(
	filters: readonly PropertyFilter[],
	fields: readonly PropertyField[],
): FilterGroup | undefined {
	if (filters.length === 0) return undefined;
	return {
		kind: "group",
		combinator: "and",
		children: filters.map((filter) => toCondition(filter, fields)),
	};
}

// --- sanitizing persisted JSON -------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeFilter(value: unknown): PropertyFilter | null {
	if (!isRecord(value) || !isPropertyFieldId(value.fieldId)) return null;
	if (value.kind === "has") return { fieldId: value.fieldId, kind: "has" };
	const scalar = value.value;
	if (
		value.kind === "is" &&
		(typeof scalar === "string" ||
			typeof scalar === "boolean" ||
			(typeof scalar === "number" && Number.isFinite(scalar)))
	) {
		return { fieldId: value.fieldId, kind: "is", value: scalar };
	}
	return null;
}

function sanitizeColumns(value: unknown): PropertyFieldId[] {
	return Array.isArray(value)
		? [...new Set(value.filter(isPropertyFieldId))]
		: [];
}

export function isDocumentTableSortColumn(
	value: unknown,
): value is DocumentTableSort["column"] {
	return (
		value === "name" ||
		value === "folder" ||
		value === "modified" ||
		value === "created" ||
		isPropertyFieldId(value)
	);
}

export function sanitizeDocumentTableSort(
	value: unknown,
): DocumentTableSort | null {
	if (!isRecord(value)) return null;
	const { column, direction } = value;
	if (!isDocumentTableSortColumn(column)) return null;
	if (direction !== "asc" && direction !== "desc") return null;
	return { column, direction };
}

export function isDocumentViewType(value: unknown): value is DocumentViewType {
	return DOCUMENT_VIEW_TYPES.includes(value as DocumentViewType);
}

function sanitizeLayout(value: Record<string, unknown>): DocumentViewLayout {
	return {
		viewType: isDocumentViewType(value.viewType) ? value.viewType : "table",
		boardField: isPropertyFieldId(value.boardField) ? value.boardField : null,
		calendarField: isPropertyFieldId(value.calendarField)
			? value.calendarField
			: null,
	};
}

function sanitizeSavedView(value: unknown): SavedDocumentView | null {
	if (!isRecord(value)) return null;
	if (typeof value.id !== "string" || value.id.length === 0) return null;
	if (typeof value.name !== "string") return null;
	const name = value.name.trim().slice(0, MAX_SAVED_VIEW_NAME_LENGTH);
	if (name.length === 0) return null;
	const sort = sanitizeDocumentTableSort(value.sort) ?? {
		column: "modified",
		direction: "desc",
	};
	const filters = Array.isArray(value.filters)
		? value.filters
				.map(sanitizeFilter)
				.filter((filter): filter is PropertyFilter => filter !== null)
		: [];
	return {
		...sanitizeLayout(value),
		id: value.id,
		name,
		sort,
		filters,
		groupBy: isPropertyFieldId(value.groupBy) ? value.groupBy : null,
		propertyColumns: sanitizeColumns(value.propertyColumns),
	};
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
		const propertyColumns = sanitizeColumns(entry.propertyColumns);
		if (saved.length === 0 && propertyColumns.length === 0) continue;
		byWorkspace[workspacePath] = { propertyColumns, saved };
	}
	return byWorkspace;
}
