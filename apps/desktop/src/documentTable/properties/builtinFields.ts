/**
 * Built-in file properties: facts about the file itself (Modified, Created,
 * Folder, Word count, Size), offered everywhere a front-matter property is —
 * columns, board/calendar field, chips, grouping, saved views.
 *
 * - Ids live under `file:`, so they can never collide with a `prop:` id: a
 *   front-matter key `created` stays its own field, and the built-in's label
 *   gains " (file)" when the labels would otherwise read the same.
 * - READ-ONLY: they come from the file system, so a board/calendar move never
 *   writes them (see `viewDrag.ts`).
 * - Size and Word count need a whole-file read; the scan only does that while
 *   the current view uses one of them (`viewUsesFileStats`).
 */
import { BUILTIN_VIEW_FIELD_IDS, type RowValue } from "@tektrg/table-core";
import type { ScannedFileStats } from "../../desktopApi/types";
import type { DocumentTableRow } from "../documentTableView";
import type {
	PropertyField,
	PropertyFieldId,
	PropertyRowValues,
} from "./propertyFields";

export const BUILTIN_FIELD_PREFIX = "file:";

/** The ids are part of the saved-view format, so they live in table-core. */
export const BUILTIN_FIELD_IDS = BUILTIN_VIEW_FIELD_IDS;

export type BuiltinFieldId =
	(typeof BUILTIN_FIELD_IDS)[keyof typeof BUILTIN_FIELD_IDS];

const BUILTIN_DEFINITIONS: readonly Pick<
	PropertyField,
	"id" | "label" | "type"
>[] = [
	{ id: BUILTIN_FIELD_IDS.modified, label: "Modified", type: "date" },
	{ id: BUILTIN_FIELD_IDS.created, label: "Created", type: "date" },
	{ id: BUILTIN_FIELD_IDS.folder, label: "Folder", type: "select" },
	{ id: BUILTIN_FIELD_IDS.wordCount, label: "Word count", type: "number" },
	{ id: BUILTIN_FIELD_IDS.size, label: "Size", type: "number" },
];

const BUILTIN_ID_SET: ReadonlySet<string> = new Set(
	BUILTIN_DEFINITIONS.map((field) => field.id),
);

/** Fields whose values need the whole-file read. */
const FILE_STATS_FIELD_IDS: ReadonlySet<string> = new Set([
	BUILTIN_FIELD_IDS.wordCount,
	BUILTIN_FIELD_IDS.size,
]);

export function isBuiltinFieldId(value: unknown): value is BuiltinFieldId {
	return typeof value === "string" && BUILTIN_ID_SET.has(value);
}

export function isFileStatsFieldId(value: unknown): boolean {
	return typeof value === "string" && FILE_STATS_FIELD_IDS.has(value);
}

/** Shown when a board/calendar move would have to change a built-in. */
export const READ_ONLY_MOVE_MESSAGE = "Can't move — this comes from the file";

/** Label for an id that is not in the field list (e.g. a stale saved view). */
export function builtinFieldLabel(fieldId: BuiltinFieldId): string {
	return (
		BUILTIN_DEFINITIONS.find((field) => field.id === fieldId)?.label ?? fieldId
	);
}

/** Folder options listed per field, most documents first (same cap as front matter). */
const MAX_FOLDER_OPTIONS = 50;

const folderOptionsByListing = new WeakMap<
	readonly DocumentTableRow[],
	string[]
>();

/** Recounted only when the listing changes (rows are memoized on it). */
function folderOptions(rows: readonly DocumentTableRow[]): string[] {
	const cached = folderOptionsByListing.get(rows);
	if (cached) return cached;
	const options = countFolderOptions(rows);
	folderOptionsByListing.set(rows, options);
	return options;
}

function countFolderOptions(rows: readonly DocumentTableRow[]): string[] {
	const counts = new Map<string, number>();
	for (const row of rows) {
		counts.set(row.folderLabel, (counts.get(row.folderLabel) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
		.slice(0, MAX_FOLDER_OPTIONS)
		.map(([folder]) => folder);
}

/**
 * The built-in fields, after the front-matter ones. A label equal (ignoring
 * case) to a front-matter field's label gains " (file)": "Created (file)" next
 * to the property "created".
 */
export function builtinFields(
	rows: readonly DocumentTableRow[],
	frontMatterFields: readonly PropertyField[],
	statsCount: number,
): PropertyField[] {
	const takenLabels = new Set(
		frontMatterFields.map((field) => field.label.trim().toLowerCase()),
	);
	return BUILTIN_DEFINITIONS.map((definition) => {
		const label = takenLabels.has(definition.label.toLowerCase())
			? `${definition.label} (file)`
			: definition.label;
		const documentCount = isFileStatsFieldId(definition.id)
			? statsCount
			: rows.length;
		return {
			...definition,
			label,
			documentCount,
			readOnly: true,
			...(definition.id === BUILTIN_FIELD_IDS.folder
				? { options: folderOptions(rows) }
				: {}),
		};
	});
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/**
 * Seconds since the epoch -> local wall-clock `YYYY-MM-DDTHH:mm:ss` (no
 * offset). Its first 10 characters are the local day, which is what the
 * calendar and table-core's date buckets read for offset-less values.
 */
export function localDateTime(epochSeconds: number): string {
	const at = new Date(epochSeconds * 1000);
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

// Rows are memoized on the listing, so the listing-derived values are built
// once per row instance, not once per scan batch.
const listingValuesByRow = new WeakMap<DocumentTableRow, PropertyRowValues>();

function listingValues(row: DocumentTableRow): PropertyRowValues {
	let values = listingValuesByRow.get(row);
	if (!values) {
		values = {
			[BUILTIN_FIELD_IDS.modified]: localDateTime(row.modifiedAt),
			[BUILTIN_FIELD_IDS.created]: localDateTime(row.createdAt),
			[BUILTIN_FIELD_IDS.folder]: row.folderLabel,
		};
		listingValuesByRow.set(row, values);
	}
	return values;
}

/**
 * One row's cell values: built-ins (Size / Word count only once read) plus its
 * front-matter values. `prop:` and `file:` ids never collide. A row with
 * neither front matter nor stats shares its listing values object.
 */
export function withBuiltinValues(
	row: DocumentTableRow,
	stats: ScannedFileStats | undefined,
	frontMatter: PropertyRowValues | undefined,
): PropertyRowValues {
	const base = listingValues(row);
	if (!stats && !frontMatter) return base;
	return {
		...base,
		...(stats
			? {
					[BUILTIN_FIELD_IDS.wordCount]: stats.wordCount,
					[BUILTIN_FIELD_IDS.size]: stats.sizeBytes,
				}
			: {}),
		...frontMatter,
	};
}

const SIZE_UNITS = ["KB", "MB", "GB"];

/** Bytes as "820 B", "12 KB", "3.4 MB" (1 KB = 1024 B). */
export function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const rounded =
		value < 10
			? value.toFixed(1).replace(/\.0$/, "")
			: String(Math.round(value));
	return `${rounded} ${SIZE_UNITS[unit]}`;
}

/** Cell text for a built-in; null = not a built-in with special formatting. */
export function formatBuiltinValue(
	fieldId: PropertyFieldId,
	value: RowValue,
): string | null {
	if (value === null || value === undefined) return null;
	if (fieldId === BUILTIN_FIELD_IDS.size && typeof value === "number") {
		return formatFileSize(value);
	}
	if (
		(fieldId === BUILTIN_FIELD_IDS.modified ||
			fieldId === BUILTIN_FIELD_IDS.created) &&
		typeof value === "string"
	) {
		return value.slice(0, 16).replace("T", " ");
	}
	if (fieldId === BUILTIN_FIELD_IDS.wordCount && typeof value === "number") {
		return value.toLocaleString();
	}
	return null;
}

/** What a view reads, for deciding whether the scan must count words. */
export type FieldUsage = {
	propertyColumns: readonly PropertyFieldId[];
	sortColumn: string;
	filterFieldIds: readonly PropertyFieldId[];
	groupBy: PropertyFieldId | null;
};

export function viewUsesFileStats(usage: FieldUsage): boolean {
	return (
		usage.propertyColumns.some(isFileStatsFieldId) ||
		isFileStatsFieldId(usage.sortColumn) ||
		usage.filterFieldIds.some(isFileStatsFieldId) ||
		isFileStatsFieldId(usage.groupBy)
	);
}

/** Built-ins the table already shows as its fixed Modified / Created / Folder columns. */
const TABLE_FIXED_COLUMN_BUILTINS: ReadonlySet<string> = new Set([
	BUILTIN_FIELD_IDS.modified,
	BUILTIN_FIELD_IDS.created,
	BUILTIN_FIELD_IDS.folder,
]);

/**
 * Fields offered by "+ Property". In table mode the built-ins duplicating a
 * fixed column are left out (unless already shown, so they can be hidden);
 * board and calendar cards have no fixed columns, so they keep them.
 */
export function addColumnMenuFields(
	fields: readonly PropertyField[],
	viewType: string,
	visibleColumns: readonly PropertyFieldId[],
): PropertyField[] {
	if (viewType !== "table") return [...fields];
	return fields.filter(
		(field) =>
			!TABLE_FIXED_COLUMN_BUILTINS.has(field.id) ||
			visibleColumns.includes(field.id),
	);
}
