import type { JSONContent } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import { markTransactionAsUserEdit } from "../ui/userEditIntentMeta.js";

/**
 * Slice 3 — pure inference behind the select chevron (charter R26, R27, R28).
 *
 * `inferColumnValues` takes a table node and a column index and hands back the
 * values the chevron offers, in first-appearance order — or an empty array
 * when the column does not qualify. No memory, nothing stored, nothing
 * validated (ruling D5): every call re-derives from the live table.
 *
 * The qualifying rule ships exactly as written (ruling R-E / R27): fewer than
 * 10 distinct values, every value under 20 characters, and deliberately NO
 * minimum row count — a 3-row table where every column qualifies offers a
 * chevron on every column, accepted cost recorded verbatim in D5.
 */

export const INFERRED_SELECT_MAX_DISTINCT = 10;
export const INFERRED_SELECT_MAX_LENGTH = 20;

/** R26/R27 — distinct column values in first-appearance order, or `[]`. */
export function inferColumnValues(
	table: JSONContent,
	columnIndex: number,
): string[] {
	const rows = tableRowsOf(table);
	// The header row holds titles, not pickable values: it neither offers
	// values nor disqualifies the column (a long header must never suppress
	// a qualifying body column).
	const bodyRows = rows.slice(1);
	if (!Number.isInteger(columnIndex) || columnIndex < 0) return [];

	const values: string[] = [];
	const seen = new Set<string>();
	for (const row of bodyRows) {
		const text = cellValueText(cellAt(row, columnIndex));
		// R28 — blank cells are not values: they never appear as an option and
		// never count toward the distinct bound.
		if (text === null) continue;
		if (seen.has(text)) continue;
		// R27 — the bounds are literal: 10 distinct or a 20-char value ends
		// the offer. Early-stop instead of a row ceiling, so a 500-row status
		// column costs one pass and a 3-row table still qualifies (R-E).
		if (text.length >= INFERRED_SELECT_MAX_LENGTH) return [];
		if (seen.size >= INFERRED_SELECT_MAX_DISTINCT) return [];
		seen.add(text);
		values.push(text);
	}
	// Exactly 10 distinct never reaches the early-stop above — the bound is
	// "fewer than 10", enforced here.
	if (seen.size >= INFERRED_SELECT_MAX_DISTINCT) return [];
	return values;
}

/**
 * R29 / ruling R-K — true only for a cell a pick can safely overwrite: every
 * inline is unmarked text, in any number of paragraphs. A link, bold, italic,
 * inline code or any other inline means "edited by typing only" — the chevron
 * is suppressed entirely so a pick can never silently flatten formatting. A
 * blank cell counts as plain (an empty cell in a qualifying column still
 * offers the chevron), and so does a cell the user split into two paragraphs:
 * the pick collapses it back to exactly one (R32).
 */
export function isPlainTextCell(cell: JSONContent | undefined): boolean {
	const blocks = cell?.content ?? [];
	return blocks.every(
		(block) =>
			block.type === "paragraph" &&
			(block.content ?? []).every(
				(inline) =>
					inline.type === "text" &&
					(!inline.marks || inline.marks.length === 0),
			),
	);
}

/**
 * The focused cell's current value for the R31 same-value short-circuit, or
 * `null` when the cell is not plain text (no chevron is shown there anyway).
 */
export function focusedCellValue(cell: JSONContent | undefined): string | null {
	if (!isPlainTextCell(cell)) return null;
	return cellValueText(cell) ?? "";
}

function cellValueText(cell: JSONContent | undefined): string | null {
	if (!cell) return null;
	const text = collectText(cell).trim();
	// R28 — values differing only by surrounding whitespace count as one, and
	// a whitespace-only cell is blank, not a value.
	return text === "" ? null : text;
}

function collectText(node: JSONContent): string {
	if (typeof node.text === "string") return node.text;
	return (node.content ?? []).map(collectText).join("");
}

function tableRowsOf(table: JSONContent): JSONContent[] {
	return (table?.content ?? []).filter((row) => row.type === "tableRow");
}

function cellAt(
	row: JSONContent | undefined,
	columnIndex: number,
): JSONContent | undefined {
	return row?.content?.[columnIndex];
}

const TABLE_NODE = "table";
const CELL_NODES = new Set(["tableCell", "tableHeader"]);
const PARAGRAPH_NODE = "paragraph";

export type CellPickTarget = {
	/** Document position of the `table` node holding the focused cell. */
	tablePos: number;
	/** Document position of the focused cell node itself. */
	cellPos: number;
	/** The focused cell's column index within its row. */
	columnIndex: number;
};

/**
 * Where the caret sits, when it sits in a table cell: the table, the cell and
 * the cell's column. `null` anywhere else — the picker then draws nothing
 * rather than acting on the wrong node (R16's posture, applied to slice 3).
 */
export function pickTargetAtSelection(
	state: EditorState,
): CellPickTarget | null {
	const { $from } = state.selection;
	for (let depth = $from.depth; depth > 0; depth -= 1) {
		const node = $from.node(depth);
		if (!CELL_NODES.has(node.type.name)) continue;
		const cellPos = $from.before(depth);
		const tableDepth = depth - 2;
		const table = tableDepth > 0 ? $from.node(tableDepth) : null;
		if (!table || table.type.name !== TABLE_NODE) return null;
		return {
			tablePos: $from.before(tableDepth),
			cellPos,
			columnIndex: $from.index(depth - 1),
		};
	}
	return null;
}

/**
 * R26 + R32 — a pick is an ordinary cell text edit (deliberately NOT a table
 * transform: it rewrites no rows or columns), replacing the WHOLE cell with
 * exactly one paragraph holding the picked value — never a leftover second
 * paragraph from a cell the user had split.
 *
 * Returns `null` and writes nothing when the pick would change nothing (R31:
 * the cell already holds the value — no file rewrite, no new revision, no
 * empty undo step) or when the cell is not plain text (R29).
 *
 * The transaction carries user-edit intent (R12 / ruling R-H) so a pick made
 * more than a second after the last keystroke still reaches the file.
 */
export function cellPickTransaction(
	state: EditorState,
	target: CellPickTarget,
	value: string,
): Transaction | null {
	const cell = state.doc.nodeAt(target.cellPos);
	if (!cell || !CELL_NODES.has(cell.type.name)) return null;
	if (!isPlainTextCell(cell.toJSON() as JSONContent)) return null;
	if ((cell.textContent ?? "").trim() === value) return null;

	const paragraph = state.schema.nodes[PARAGRAPH_NODE]?.create(
		null,
		state.schema.text(value),
	);
	if (!paragraph) return null;
	const transaction = state.tr.replaceWith(
		target.cellPos + 1,
		target.cellPos + cell.nodeSize - 1,
		paragraph,
	);
	transaction.setSelection(
		TextSelection.near(transaction.doc.resolve(target.cellPos + 1)),
	);
	return markTransactionAsUserEdit(transaction);
}
