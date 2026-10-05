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
	type FilterGroup,
	looseFoldText,
	type SourceRow,
	SPEC_VERSION,
	type ViewSpec,
} from "@tektrg/table-core";
import {
	type DocumentTableColumn,
	type DocumentTableRow,
	type DocumentTableView,
	ROOT_FOLDER_LABEL,
} from "./documentTableView";

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

function filterForQuery(query: string): FilterGroup | undefined {
	// A query that folds to nothing (" ", "-") means "no filter", as before.
	if (looseFoldText(query).length === 0) return undefined;
	return {
		kind: "group",
		combinator: "and",
		children: [
			{
				kind: "condition",
				fieldId: FILE_NAME_FIELD,
				operator: "contains",
				value: query,
				match: "loose",
			},
		],
	};
}

/** The document table's view as an engine `ViewSpec` (persisted sort format unchanged). */
export function toDocumentViewSpec(
	view: Pick<DocumentTableView, "filter" | "sort">,
): ViewSpec {
	const isText = view.sort.column === "name" || view.sort.column === "folder";
	return {
		specVersion: SPEC_VERSION,
		viewType: "table",
		filter: filterForQuery(view.filter),
		sort: [
			{
				fieldId: SORT_FIELD_BY_COLUMN[view.sort.column],
				direction: view.sort.direction,
				...(isText ? { collation: "caseless" as const } : {}),
			},
		],
	};
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
): DocumentTableRow[] {
	const sortKey = `${sort.column}:${sort.direction}`;
	if (sortedRowsMemo?.rows === rows && sortedRowsMemo.sortKey === sortKey) {
		return sortedRowsMemo.sorted;
	}
	const { sourceRows, rowByPath } = toSourceRows(rows);
	const result = evaluate(
		toDocumentViewSpec({ filter: "", sort }),
		sourceRows,
		DOCUMENT_FIELDS,
	);
	if (!result.ok) {
		// The spec is built here from typed inputs, so this is a programming error.
		throw new Error(
			`document table spec rejected: ${result.errors[0]?.message}`,
		);
	}
	const sorted = result.rows.map(
		(sourceRow) => rowByPath.get(sourceRow.id as string) as DocumentTableRow,
	);
	sortedRowsMemo = { rows, sortKey, sorted };
	return sorted;
}

/**
 * Filter + sort with the engine's semantics. The sort is `evaluate` (memoized
 * above); the filter is the engine's loose `contains` applied to the
 * precomputed `searchName` (= `looseFoldText(file name)`), which equals
 * `evaluate` with the same filter — pinned by the parity tests — but skips
 * re-folding every file name on each keystroke (~45 ms at 50k files).
 * Filtering keeps order, so filtering the sorted list is the full result.
 */
export function filterAndSortDocumentRows(
	rows: DocumentTableRow[],
	view: Pick<DocumentTableView, "filter" | "sort">,
): DocumentTableRow[] {
	const sorted = sortDocumentRows(rows, view.sort);
	const needle = looseFoldText(view.filter);
	if (needle.length === 0) return sorted;
	return sorted.filter((row) => row.searchName.includes(needle));
}

/** Test seam: drops the sort memo so fixtures cannot leak between cases. */
export function resetDocumentSortMemo() {
	sortedRowsMemo = null;
}

/** The unoptimized reference: one `evaluate` call with filter + sort. Tests only. */
export function evaluateDocumentRowsForTest(
	rows: DocumentTableRow[],
	view: Pick<DocumentTableView, "filter" | "sort">,
): DocumentTableRow[] {
	const { sourceRows, rowByPath } = toSourceRows(rows);
	const result = evaluate(
		toDocumentViewSpec(view),
		sourceRows,
		DOCUMENT_FIELDS,
	);
	if (!result.ok) throw new Error(result.errors[0]?.message);
	return result.rows.map(
		(sourceRow) => rowByPath.get(sourceRow.id as string) as DocumentTableRow,
	);
}
