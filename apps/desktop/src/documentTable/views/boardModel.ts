/**
 * Board (kanban) layout as plain data: one column per value of a select
 * field, plus a trailing "No <field>" column. Cards keep the order they
 * arrive in — the view's sort — so the board never has its own ordering to
 * persist.
 */
import type { DocumentTableRow } from "../documentTableView";
import {
	type PropertyField,
	type PropertyFieldId,
	propertyFieldId,
} from "../properties/propertyFields";

/** Cards rendered per column before "Show more"; keeps a 5k-note board cheap. */
export const BOARD_COLUMN_CARD_LIMIT = 100;

/**
 * Value columns shown before the rest fold into "Other". Also the most
 * distinct values a free-text field may have and still be offered as a board.
 */
export const BOARD_MAX_VALUE_COLUMNS = 30;

export type BoardColumnKind = "value" | "empty" | "other";

export type BoardColumn = {
	/** Stable identity (React key, "show more" state). */
	key: string;
	kind: BoardColumnKind;
	/** The value a card dropped here gets; null = remove the key. Unused for "other". */
	value: string | null;
	label: string;
	/** Cards to render (capped), in the view's sort order. */
	rows: DocumentTableRow[];
	total: number;
};

export type BoardModel = {
	field: PropertyField;
	columns: BoardColumn[];
};

export const EMPTY_COLUMN_KEY = "\u0000empty";
export const OTHER_COLUMN_KEY = "\u0000other";

export function boardColumnKey(value: string | null): string {
	return value === null ? EMPTY_COLUMN_KEY : `v:${value}`;
}

/** The single value a card has for `fieldId` (first tag of a list); null = none. */
export function cardValue(
	row: DocumentTableRow,
	fieldId: PropertyFieldId,
): string | null {
	const value = row.properties?.[fieldId];
	if (value === null || value === undefined) return null;
	const text = Array.isArray(value) ? value[0] : String(value);
	return text && text.trim().length > 0 ? text.trim() : null;
}

function distinctValueCount(
	rows: readonly DocumentTableRow[],
	fieldId: PropertyFieldId,
	stopAfter: number,
): number {
	const seen = new Set<string>();
	for (const row of rows) {
		const value = cardValue(row, fieldId);
		if (value === null) continue;
		seen.add(value);
		if (seen.size > stopAfter) break;
	}
	return seen.size;
}

/**
 * Fields a board can split on: every select, plus free text with at most
 * `BOARD_MAX_VALUE_COLUMNS` distinct values (prose would be a column per note).
 */
export function boardFieldCandidates(
	fields: readonly PropertyField[],
	rows: readonly DocumentTableRow[],
): PropertyField[] {
	return fields.filter(
		(field) =>
			field.type === "select" ||
			(field.type === "text" &&
				distinctValueCount(rows, field.id, BOARD_MAX_VALUE_COLUMNS) <=
					BOARD_MAX_VALUE_COLUMNS),
	);
}

/**
 * The field the board splits on: the view's choice when it is still a
 * candidate, else one named `status`, else the commonest select (free text is
 * only ever a board by explicit choice or by being named `status`).
 */
export function resolveBoardField(
	candidates: readonly PropertyField[],
	chosen: PropertyFieldId | null,
): PropertyField | null {
	return (
		candidates.find((field) => field.id === chosen) ??
		candidates.find((field) => field.id === propertyFieldId("status")) ??
		candidates.find((field) => field.type === "select") ??
		null
	);
}

/**
 * Columns in the field's option order (most used first), then values seen on
 * the rows but missing from the options; past `BOARD_MAX_VALUE_COLUMNS` the
 * rest fold into "Other" (no drops); the empty column is last. `limitFor`
 * caps rendered cards per column key; `total` still counts every card.
 */
export function buildBoardModel(
	rows: readonly DocumentTableRow[],
	field: PropertyField,
	limitFor: (key: string) => number = () => BOARD_COLUMN_CARD_LIMIT,
): BoardModel {
	const byValue = new Map<string, DocumentTableRow[]>();
	for (const option of field.options ?? []) byValue.set(option, []);
	const empty: DocumentTableRow[] = [];
	for (const row of rows) {
		const value = cardValue(row, field.id);
		if (value === null) {
			empty.push(row);
			continue;
		}
		let bucket = byValue.get(value);
		if (!bucket) {
			bucket = [];
			byValue.set(value, bucket);
		}
		bucket.push(row);
	}
	const columns: BoardColumn[] = [];
	const other: DocumentTableRow[] = [];
	let otherValueCount = 0;
	for (const [value, bucket] of byValue) {
		if (columns.length >= BOARD_MAX_VALUE_COLUMNS) {
			other.push(...bucket);
			otherValueCount += 1;
			continue;
		}
		const key = boardColumnKey(value);
		columns.push({
			key,
			kind: "value",
			value,
			label: value,
			rows: bucket.slice(0, limitFor(key)),
			total: bucket.length,
		});
	}
	if (otherValueCount > 0) {
		columns.push({
			key: OTHER_COLUMN_KEY,
			kind: "other",
			value: null,
			label: `Other (${otherValueCount} values)`,
			rows: other.slice(0, limitFor(OTHER_COLUMN_KEY)),
			total: other.length,
		});
	}
	columns.push({
		key: EMPTY_COLUMN_KEY,
		kind: "empty",
		value: null,
		label: `No ${field.label}`,
		rows: empty.slice(0, limitFor(EMPTY_COLUMN_KEY)),
		total: empty.length,
	});
	return { field, columns };
}

/** Columns a card can be moved to (keyboard "Move to"): every droppable one but its own. */
export function moveTargetsFor(
	row: DocumentTableRow,
	model: BoardModel,
): BoardColumn[] {
	const current = cardValue(row, model.field.id);
	return model.columns.filter(
		(column) => column.kind !== "other" && column.value !== current,
	);
}
