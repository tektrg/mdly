import type { JSONContent } from "@tiptap/core";

/**
 * The four pure GFM-table rewrite rules (charter R2, R3, R5, R7, R8, R9, R11).
 *
 * Each takes the table node's JSON and hands back a *new* table node, or a
 * signal that the caller must write nothing at all. They never touch the
 * document, never serialize a cell back to Markdown text (whole cell nodes are
 * moved, so escaped pipes and inline code survive by construction — R11), and
 * never re-derive alignment (it rides along on the header cell's `align`
 * attribute, which is the only place the serializer reads it — R2).
 *
 * `prosemirror-tables` is deliberately absent: it would introduce colspan and
 * rowspan, which GFM pipe tables physically cannot serialize (ruling D1).
 */
export type TableTransformResult =
	/** Nothing to do. The caller must dispatch no transaction at all (R8). */
	| { kind: "unchanged" }
	/** Replace the table node with this one, in a single transaction (R10). */
	| { kind: "table"; table: JSONContent }
	/** Drop the whole table block from the document (R5). */
	| { kind: "removeTable" };

/** A rewrite rule with its arguments already bound, ready for the applier. */
export type TableTransform = (table: JSONContent) => TableTransformResult;

const UNCHANGED: TableTransformResult = { kind: "unchanged" };
const REMOVE_TABLE: TableTransformResult = { kind: "removeTable" };

const TABLE_ROW_TYPE = "tableRow";
const TABLE_HEADER_TYPE = "tableHeader";
const TABLE_CELL_TYPE = "tableCell";

export type TableShape = {
	/** Cells in the widest row — the canonical width per ruling R-F. */
	columnCount: number;
	/** Rows below the header row; the header itself is never counted (R3). */
	bodyRowCount: number;
};

/**
 * What the handle layer needs to know before it draws anything: how many
 * column dots and how many row dots. A header-only table reports zero body
 * rows, which is what makes a row move a no-op there (R7).
 */
export function readTableShape(table: JSONContent): TableShape {
	const rows = tableRowsOf(table);
	return {
		columnCount: widestRowCellCount(rows),
		bodyRowCount: Math.max(0, rows.length - 1),
	};
}

/** R2 — move a whole column, header cell and alignment included. */
export function moveTableColumn(
	table: JSONContent,
	fromColumnIndex: number,
	toColumnIndex: number,
): TableTransformResult {
	const rows = tableRowsOf(table);
	const columnCount = widestRowCellCount(rows);
	if (!isWithin(fromColumnIndex, columnCount)) return UNCHANGED;
	if (!isWithin(toColumnIndex, columnCount)) return UNCHANGED;
	if (fromColumnIndex === toColumnIndex) return UNCHANGED;

	const squared = squaredOffRows(rows, columnCount);
	return tableResult(
		table,
		squared.map((row) =>
			rowWithCells(row, moveItem(cellsOf(row), fromColumnIndex, toColumnIndex)),
		),
	);
}

/**
 * R3 — reorder a body row. Indices are body-relative (0 is the first row
 * *under* the header), which is what makes "the header can never move and
 * nothing can be dropped above it" structural rather than a runtime check.
 */
export function moveTableRow(
	table: JSONContent,
	fromBodyRowIndex: number,
	toBodyRowIndex: number,
): TableTransformResult {
	const rows = tableRowsOf(table);
	const bodyRowCount = Math.max(0, rows.length - 1);
	if (!isWithin(fromBodyRowIndex, bodyRowCount)) return UNCHANGED;
	if (!isWithin(toBodyRowIndex, bodyRowCount)) return UNCHANGED;
	if (fromBodyRowIndex === toBodyRowIndex) return UNCHANGED;

	const squared = squaredOffRows(rows, widestRowCellCount(rows));
	return tableResult(table, [
		squared[0],
		...moveItem(squared.slice(1), fromBodyRowIndex, toBodyRowIndex),
	]);
}

/** R5 — deleting the last remaining column removes the whole table block. */
export function deleteTableColumn(
	table: JSONContent,
	columnIndex: number,
): TableTransformResult {
	const rows = tableRowsOf(table);
	const columnCount = widestRowCellCount(rows);
	if (!isWithin(columnIndex, columnCount)) return UNCHANGED;
	if (columnCount === 1) return REMOVE_TABLE;

	const squared = squaredOffRows(rows, columnCount);
	return tableResult(
		table,
		squared.map((row) =>
			rowWithCells(row, withoutIndex(cellsOf(row), columnIndex)),
		),
	);
}

/** R5 — deleting the last remaining body row removes the whole table block. */
export function deleteTableRow(
	table: JSONContent,
	bodyRowIndex: number,
): TableTransformResult {
	const rows = tableRowsOf(table);
	const bodyRowCount = Math.max(0, rows.length - 1);
	if (!isWithin(bodyRowIndex, bodyRowCount)) return UNCHANGED;
	if (bodyRowCount === 1) return REMOVE_TABLE;

	const squared = squaredOffRows(rows, widestRowCellCount(rows));
	return tableResult(table, [
		squared[0],
		...withoutIndex(squared.slice(1), bodyRowIndex),
	]);
}

function tableResult(
	table: JSONContent,
	rows: JSONContent[],
): TableTransformResult {
	// Spreading `table` keeps its attributes — including the session-only
	// `uid` — so a reorder never resets per-table app state (R24).
	return { kind: "table", table: { ...table, content: rows } };
}

function tableRowsOf(table: JSONContent): JSONContent[] {
	return (table.content ?? []).filter((row) => row.type === TABLE_ROW_TYPE);
}

function cellsOf(row: JSONContent | undefined): JSONContent[] {
	return row?.content ?? [];
}

function widestRowCellCount(rows: JSONContent[]): number {
	return rows.reduce((widest, row) => Math.max(widest, cellsOf(row).length), 0);
}

function rowWithCells(row: JSONContent, cells: JSONContent[]): JSONContent {
	return { ...row, content: cells };
}

/**
 * R9 / ruling R-F — square the table off to the *widest* row, padding short
 * rows with empty cells and never trimming a cell away. Runs only from inside
 * a transform that is actually committing, so hovering or a cancelled drag
 * still writes nothing (ruling R-B).
 */
function squaredOffRows(
	rows: JSONContent[],
	columnCount: number,
): JSONContent[] {
	const headerCells = cellsOf(rows[0]);
	return rows.map((row, rowIndex) => {
		const cells = cellsOf(row);
		if (cells.length === columnCount) return row;
		const padded = [...cells];
		while (padded.length < columnCount) {
			padded.push(
				emptyCell(rowIndex === 0, alignOf(headerCells[padded.length])),
			);
		}
		return rowWithCells(row, padded);
	});
}

function emptyCell(isHeaderRow: boolean, align: string | null): JSONContent {
	return {
		type: isHeaderRow ? TABLE_HEADER_TYPE : TABLE_CELL_TYPE,
		attrs: { align },
		content: [{ type: "paragraph" }],
	};
}

function alignOf(cell: JSONContent | undefined): string | null {
	const align = cell?.attrs?.align;
	return align === "left" || align === "center" || align === "right"
		? align
		: null;
}

function isWithin(index: number, count: number): boolean {
	return Number.isInteger(index) && index >= 0 && index < count;
}

function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
	const next = [...items];
	const [moved] = next.splice(fromIndex, 1);
	next.splice(toIndex, 0, moved);
	return next;
}

function withoutIndex<T>(items: T[], index: number): T[] {
	return items.filter((_, itemIndex) => itemIndex !== index);
}
