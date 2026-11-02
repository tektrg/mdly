/**
 * Adapter from the document table onto the portfolio table engine
 * (`@tektrg/table-core`): filter and sort run through its `evaluate`, so the
 * document list follows the same rules as every other table in the family.
 *
 * MDLY-only rules stay with the callers: which files are rows at all, the
 * pinned open document, header-click defaults and the nav grouping.
 */
import {
	evaluate,
	type FieldDefinition,
	type FilterCondition,
	type FilterGroup,
	type FilterNode,
	looseFoldText,
	type SortKey,
	type SourceRow,
	SPEC_VERSION,
	type ViewSpec,
} from "@tektrg/table-core";
import type {
	DocumentTableColumn,
	DocumentTableRow,
	DocumentTableSort,
	DocumentTableView,
} from "./documentTableView";
import {
	isPropertyValueFilter,
	matchesFolderFilters,
	type PropertyFilter,
	propertyFiltersToFilterGroup,
} from "./properties/documentViews";
import {
	isPropertyFieldId,
	type PropertyField,
} from "./properties/propertyFields";

/**
 * Folder cell for a document sitting directly in the workspace root. Lives
 * here (re-exported by `documentTableView.ts`) so this module imports only
 * types from the view and there is no runtime import cycle.
 */
export const ROOT_FOLDER_LABEL = "—";

/** The file name WITH its extension — what the filter box matches (see `searchName`). */
const FILE_NAME_FIELD = "fileName";

const DOCUMENT_FIELDS: FieldDefinition[] = [
	{ id: FILE_NAME_FIELD, label: "File name", type: "text" },
	{ id: "name", label: "Name", type: "text" },
	{ id: "folder", label: "Folder", type: "text" },
	{ id: "modified", label: "Modified", type: "number" },
	{ id: "created", label: "Created", type: "number" },
];

/**
 * Folder sort key for workspace-root documents. The "—" label is punctuation,
 * which ICU sorted before every folder name but code-point order puts after
 * them; root documents must still lead an ascending folder sort. NUL cannot
 * occur in a path, so it sorts before every real folder in both directions.
 */
const ROOT_FOLDER_SORT_KEY = "\u0000";

type DocumentSourceRows = {
	sourceRows: SourceRow[];
	rowByPath: Map<string, DocumentTableRow>;
};

// Keyed on the projected array, which `buildDocumentRows` memoizes on the
// listing: the keystroke path reuses these instead of rebuilding 50k objects.
const sourceRowsCache = new WeakMap<DocumentTableRow[], DocumentSourceRows>();

function toSourceRows(rows: DocumentTableRow[]): DocumentSourceRows {
	const cached = sourceRowsCache.get(rows);
	if (cached) return cached;
	const sourceRows: SourceRow[] = rows.map((row) => ({
		// id = path, and the engine's default tie-break is ascending id: equal
		// sort keys keep a stable path order, so the R4 reorder animation never
		// jitters on watcher events.
		id: row.path,
		// Already loose-folded at projection time; folding is idempotent, so the
		// engine's own fold of it is cheap and gives the same match.
		[FILE_NAME_FIELD]: row.searchName,
		name: row.name,
		folder:
			row.folderLabel === ROOT_FOLDER_LABEL
				? ROOT_FOLDER_SORT_KEY
				: row.folderLabel,
		modified: row.modifiedAt,
		created: row.createdAt,
		// `prop:` ids never collide with the built-in field ids above.
		...row.properties,
	}));
	const built = {
		sourceRows,
		rowByPath: new Map(rows.map((row) => [row.path, row])),
	};
	sourceRowsCache.set(rows, built);
	return built;
}

const SORT_FIELD_BY_COLUMN: Record<DocumentTableColumn, string> = {
	name: "name",
	folder: "folder",
	modified: "modified",
	created: "created",
};

/** The view's sort as an engine key; a property no longer in the workspace (or multi-value) falls back to the default. */
function resolveSortKey(
	sort: DocumentTableSort,
	propertyFields: readonly PropertyField[],
): SortKey {
	if (isPropertyFieldId(sort.column)) {
		const field = propertyFields.find(
			(candidate) => candidate.id === sort.column,
		);
		if (field && field.type !== "multiSelect") {
			const isText = field.type === "text" || field.type === "select";
			return {
				fieldId: field.id,
				direction: sort.direction,
				...(isText ? { collation: "caseless" as const } : {}),
			};
		}
		return { fieldId: "modified", direction: "desc" };
	}
	const column = sort.column as DocumentTableColumn;
	const isText = column === "name" || column === "folder";
	return {
		fieldId: SORT_FIELD_BY_COLUMN[column],
		direction: sort.direction,
		...(isText ? { collation: "caseless" as const } : {}),
	};
}

function nameFilterCondition(query: string): FilterCondition | undefined {
	// A query that folds to nothing (" ", "-") means "no filter", as before.
	if (looseFoldText(query).length === 0) return undefined;
	return {
		kind: "condition",
		fieldId: FILE_NAME_FIELD,
		operator: "contains",
		value: query,
		match: "loose",
	};
}

function engineFields(
	propertyFields: readonly PropertyField[],
): FieldDefinition[] {
	return propertyFields.length === 0
		? DOCUMENT_FIELDS
		: [...DOCUMENT_FIELDS, ...propertyFields];
}

/** A chip on a property no document carries matches nothing (not everything). */
function referencesMissingField(
	view: EngineView,
	propertyFields: readonly PropertyField[],
): boolean {
	return (view.propertyFilters ?? [])
		.filter(isPropertyValueFilter)
		.some(
			(filter) => !propertyFields.some((field) => field.id === filter.fieldId),
		);
}

/** The row's workspace-relative path as `folder:` matching needs it. */
function rowFolderPath(row: DocumentTableRow): string {
	// Only the folder decides membership; the leaf name is a placeholder so a
	// root file (`AptusFit.md`) is never "inside" a folder (R7).
	return row.folderLabel === ROOT_FOLDER_LABEL ? "_" : `${row.folderLabel}/_`;
}

/** `folder:` chips AND-ed over the rows; the same predicate on both paths. */
function applyFolderFilters(
	rows: DocumentTableRow[],
	filters: readonly PropertyFilter[],
): DocumentTableRow[] {
	if (!filters.some((filter) => filter.kind === "folder")) return rows;
	return rows.filter((row) =>
		matchesFolderFilters(rowFolderPath(row), filters),
	);
}

type EngineView = Pick<DocumentTableView, "filter" | "sort"> &
	Partial<Pick<DocumentTableView, "propertyFilters">>;

/** The document table's view as an engine `ViewSpec` (persisted sort format unchanged). */
export function toDocumentViewSpec(
	view: EngineView,
	propertyFields: readonly PropertyField[] = [],
): ViewSpec {
	const nameCondition = nameFilterCondition(view.filter);
	const propertyGroup = propertyFiltersToFilterGroup(
		view.propertyFilters ?? [],
		propertyFields,
	);
	const children: FilterNode[] = [
		...(nameCondition ? [nameCondition] : []),
		...(propertyGroup?.children ?? []),
	];
	const filter: FilterGroup | undefined =
		children.length > 0
			? { kind: "group", combinator: "and", children }
			: undefined;
	return {
		specVersion: SPEC_VERSION,
		viewType: "table",
		filter,
		sort: [resolveSortKey(view.sort, propertyFields)],
	};
}

function runEvaluate(
	spec: ViewSpec,
	rows: DocumentTableRow[],
	propertyFields: readonly PropertyField[],
): DocumentTableRow[] {
	const { sourceRows, rowByPath } = toSourceRows(rows);
	const result = evaluate(spec, sourceRows, engineFields(propertyFields));
	if (!result.ok) {
		// The spec is built here from typed inputs, so this is a programming error.
		throw new Error(
			`document table spec rejected: ${result.errors[0]?.message}`,
		);
	}
	return result.rows.map(
		(sourceRow) => rowByPath.get(sourceRow.id as string) as DocumentTableRow,
	);
}

/** One engine `evaluate` over the rows, mapped back to the row objects. */
function evaluateDocumentRows(
	rows: DocumentTableRow[],
	view: EngineView,
	propertyFields: readonly PropertyField[] = [],
): DocumentTableRow[] {
	if (referencesMissingField(view, propertyFields)) return [];
	return applyFolderFilters(
		runEvaluate(toDocumentViewSpec(view, propertyFields), rows, propertyFields),
		view.propertyFilters ?? [],
	);
}

type SortedRowsMemo = {
	rows: DocumentTableRow[];
	sortKey: string;
	sorted: DocumentTableRow[];
};

let sortedRowsMemo: SortedRowsMemo | null = null;

/**
 * The engine's sort of every row, memoized on the projected array + sort. The
 * sort never depends on the query, so typing never re-sorts 50k rows.
 */
function sortDocumentRows(
	rows: DocumentTableRow[],
	sort: DocumentTableView["sort"],
	propertyFields: readonly PropertyField[],
): DocumentTableRow[] {
	const key = resolveSortKey(sort, propertyFields);
	const sortKey = `${key.fieldId}:${key.direction}:${key.collation ?? ""}`;
	if (sortedRowsMemo?.rows === rows && sortedRowsMemo.sortKey === sortKey) {
		return sortedRowsMemo.sorted;
	}
	const sorted = runEvaluate(
		{ specVersion: SPEC_VERSION, viewType: "table", sort: [key] },
		rows,
		propertyFields,
	);
	sortedRowsMemo = { rows, sortKey, sorted };
	return sorted;
}

type PropertyFilteredMemo = {
	sorted: DocumentTableRow[];
	filtersKey: string;
	filtered: DocumentTableRow[];
};

let propertyFilteredMemo: PropertyFilteredMemo | null = null;

/**
 * The property chips applied to the sorted rows, keeping their order
 * (`tieBreak: "sourceOrder"`, no sort keys). Memoized like the sort, so typing
 * in the name box never re-evaluates the chips over 50k rows.
 */
function applyPropertyFilters(
	sorted: DocumentTableRow[],
	view: EngineView,
	propertyFields: readonly PropertyField[],
): DocumentTableRow[] {
	const filters = view.propertyFilters ?? [];
	if (filters.length === 0) return sorted;
	if (referencesMissingField(view, propertyFields)) return [];
	const filtersKey = JSON.stringify(filters);
	if (
		propertyFilteredMemo?.sorted === sorted &&
		propertyFilteredMemo.filtersKey === filtersKey
	) {
		return propertyFilteredMemo.filtered;
	}
	const valueGroup = propertyFiltersToFilterGroup(filters, propertyFields);
	const filtered = applyFolderFilters(
		valueGroup
			? runEvaluate(
					{
						specVersion: SPEC_VERSION,
						viewType: "table",
						filter: valueGroup,
						tieBreak: "sourceOrder",
					},
					sorted,
					propertyFields,
				)
			: sorted,
		filters,
	);
	propertyFilteredMemo = { sorted, filtersKey, filtered };
	return filtered;
}

/**
 * Filter + sort with the engine's semantics. The sort is `evaluate` (memoized
 * above), then the property chips (memoized), then the name box: the engine's
 * loose `contains` applied to the precomputed `searchName` (=
 * `looseFoldText(file name)`), which equals `evaluate` with the same filter —
 * pinned by the parity tests — but skips re-folding every file name on each
 * keystroke (~45 ms at 50k files). Filtering keeps order, so filtering the
 * sorted list is the full result.
 */
export function filterAndSortDocumentRows(
	rows: DocumentTableRow[],
	view: EngineView,
	propertyFields: readonly PropertyField[] = [],
): DocumentTableRow[] {
	const sorted = sortDocumentRows(rows, view.sort, propertyFields);
	const chipFiltered = applyPropertyFilters(sorted, view, propertyFields);
	const needle = looseFoldText(view.filter);
	if (needle.length === 0) return chipFiltered;
	return chipFiltered.filter((row) => row.searchName.includes(needle));
}

/** Test seam: drops the sort memo so fixtures cannot leak between cases. */
export function resetDocumentSortMemo() {
	sortedRowsMemo = null;
	propertyFilteredMemo = null;
}

/** The unoptimized reference (one `evaluate` with filter + sort), for parity tests. */
export const evaluateDocumentRowsForTest = evaluateDocumentRows;
