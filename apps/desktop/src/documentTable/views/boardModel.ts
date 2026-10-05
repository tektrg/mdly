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

export type BoardColumn = {
	/** The front-matter value; null = the "No <field>" column. */
	value: string | null;
	label: string;
	/** Cards to render (at most `limit`), in the view's sort order. */
	rows: DocumentTableRow[];
	total: number;
};

export type BoardModel = {
	field: PropertyField;
	columns: BoardColumn[];
};

/** A board splits on one value per note: a select, or plain text by choice. */
export function isBoardField(field: PropertyField): boolean {
	return field.type === "select" || field.type === "text";
}

/**
 * The field the board splits on: the view's choice when it is still a
 * board-able field, else one named `status`, else the commonest select
 * (free text is only ever a board by explicit choice).
 */
export function resolveBoardField(
	fields: readonly PropertyField[],
	chosen: PropertyFieldId | null,
): PropertyField | null {
	const candidates = fields.filter(isBoardField);
	return (
		candidates.find((field) => field.id === chosen) ??
		candidates.find((field) => field.id === propertyFieldId("status")) ??
		candidates.find((field) => field.type === "select") ??
		null
	);
}

function cardValue(row: DocumentTableRow, fieldId: PropertyFieldId) {
	const value = row.properties?.[fieldId];
	if (value === null || value === undefined) return null;
	const text = Array.isArray(value) ? value[0] : String(value);
	return text && text.trim().length > 0 ? text.trim() : null;
}

/**
 * Columns in the field's option order (most used first), then values seen on
 * the rows but missing from the options, then the empty column. `limitFor`
 * caps rendered cards per column; `total` still counts every card.
 */
export function buildBoardModel(
	rows: readonly DocumentTableRow[],
	field: PropertyField,
	limitFor: (value: string | null) => number = () => BOARD_COLUMN_CARD_LIMIT,
): BoardModel {
	const byValue = new Map<string | null, DocumentTableRow[]>();
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
	byValue.set(null, empty);
	const columns: BoardColumn[] = [];
	for (const [value, bucket] of byValue) {
		columns.push({
			value,
			label: value ?? `No ${field.label}`,
			rows: bucket.slice(0, limitFor(value)),
			total: bucket.length,
		});
	}
	return { field, columns };
}
