import type { JSONContent } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
	type EditorState,
	TextSelection,
	type Transaction,
} from "@tiptap/pm/state";
import { markTransactionAsUserEdit } from "../ui/userEditIntentMeta.js";
import type { TableTransform } from "./tableTransforms.js";

const TABLE_NODE = "table";
const PARAGRAPH_NODE = "paragraph";

/**
 * The single commit path for every table command (charter R10).
 *
 * Builds **one** transaction for the whole gesture — squaring-off, the move or
 * delete, a whole-table removal and the caret fix all ride together — so one
 * gesture is one file change and one Cmd+Z. Returns `null` when the transform
 * changed nothing, which is what makes hovering, a dismissed menu and a
 * cancelled or nowhere-to-go drag write literally nothing (R8): the caller
 * dispatches no transaction, so there is no revision, no save and no dirty git.
 *
 * The returned transaction is stamped as a user edit (R12 / ruling R-H) so a
 * gesture slower than the editor's 1-second intent window still saves.
 */
export function tableTransformTransaction(
	state: EditorState,
	tablePos: number,
	transform: TableTransform,
): Transaction | null {
	const table = tableNodeAt(state, tablePos);
	if (!table) return null;

	const result = transform(table.toJSON() as JSONContent);
	if (result.kind === "unchanged") return null;

	const transaction = state.tr;
	const tableEnd = tablePos + table.nodeSize;
	if (result.kind === "removeTable") {
		removeTableBlock(transaction, state, tablePos, tableEnd);
	} else {
		transaction.replaceWith(
			tablePos,
			tableEnd,
			state.schema.nodeFromJSON(result.table),
		);
	}

	placeCaretInSurvivingDocument(transaction, state.selection.from);
	// A table action is its own undo step: characters typed straight after it
	// must not be swallowed into the same Cmd+Z (R10).
	closeHistory(transaction);
	return markTransactionAsUserEdit(transaction);
}

function tableNodeAt(
	state: EditorState,
	tablePos: number,
): ProseMirrorNode | null {
	if (tablePos < 0 || tablePos >= state.doc.content.size) return null;
	const node = state.doc.nodeAt(tablePos);
	return node?.type.name === TABLE_NODE ? node : null;
}

/**
 * R5 / R6 — the whole table block goes, and a container the table was the only
 * content of (the document, a toggle, a callout, a blockquote, another table's
 * cell) is left valid and still editable as an empty paragraph rather than an
 * empty skeleton or a schema error.
 */
function removeTableBlock(
	transaction: Transaction,
	state: EditorState,
	from: number,
	to: number,
): void {
	const $table = state.doc.resolve(from);
	const paragraph = state.schema.nodes[PARAGRAPH_NODE];
	const containerHeldOnlyThisTable = $table.parent.childCount === 1;
	if (
		paragraph &&
		containerHeldOnlyThisTable &&
		$table.parent.canReplaceWith($table.index(), $table.index() + 1, paragraph)
	) {
		transaction.replaceWith(from, to, paragraph.create());
		return;
	}
	transaction.delete(from, to);
}

/**
 * R15 — the caret lands somewhere valid even when it was inside the row or
 * column that just disappeared. Mapping first keeps an untouched caret exactly
 * where it was; `TextSelection.near` rescues one whose position is gone.
 */
function placeCaretInSurvivingDocument(
	transaction: Transaction,
	previousFrom: number,
): void {
	const mapped = transaction.mapping.map(previousFrom, -1);
	const clamped = Math.max(0, Math.min(mapped, transaction.doc.content.size));
	transaction.setSelection(
		TextSelection.near(transaction.doc.resolve(clamped)),
	);
}
