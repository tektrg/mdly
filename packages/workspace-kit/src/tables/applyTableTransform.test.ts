// @vitest-environment happy-dom
import type { Editor } from "@tiptap/core";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";
import { transactionCarriesUserEditIntent } from "../ui/userEditIntentMeta.js";
import {
	destroyHarnessEditors,
	editorFromMarkdown,
	markdownOf,
	tablePosition,
} from "./__tests__/tableEditorHarness.js";
import { tableTransformTransaction } from "./applyTableTransform.js";
import {
	deleteTableColumn,
	deleteTableRow,
	moveTableColumn,
	moveTableRow,
} from "./tableTransforms.js";

afterEach(destroyHarnessEditors);

const RAGGED_TABLE = [
	"| A | B | C |",
	"| --- | --- | --- |",
	"| 1 | 2 | 3 |",
	"| 4 | 5 |",
].join("\n");

describe("one gesture is one transaction (R10)", () => {
	it("EC7: squaring-off and the transform ride in a single transaction", () => {
		const editor = editorFromMarkdown(RAGGED_TABLE);
		const dispatched = recordDispatchedTransactions(editor);

		const transaction = buildTransform(editor, (table) =>
			moveTableRow(table, 0, 1),
		);
		editor.view.dispatch(requireTransaction(transaction));

		expect(dispatched.filter((tr) => tr.docChanged)).toHaveLength(1);
		expect(markdownOf(editor)).toBe(
			[
				"| A | B | C |",
				"| --- | --- | --- |",
				"| 4 | 5 |  |",
				"| 1 | 2 | 3 |",
			].join("\n"),
		);
	});

	it("EC7/REG-5: one undo restores the pre-action document, short row included", () => {
		const editor = editorFromMarkdown(RAGGED_TABLE);
		const before = markdownOf(editor);

		editor.view.dispatch(
			requireTransaction(
				buildTransform(editor, (table) => moveTableRow(table, 0, 1)),
			),
		);
		editor.commands.undo();

		expect(markdownOf(editor)).toBe(before);
	});

	it("REG-5: one undo restores a whole table removed by its last column", () => {
		const editor = editorFromMarkdown(
			["intro", "", "| A |", "| --- |", "| 1 |"].join("\n"),
		);
		const before = markdownOf(editor);

		editor.view.dispatch(
			requireTransaction(
				buildTransform(editor, (table) => deleteTableColumn(table, 0)),
			),
		);
		expect(markdownOf(editor)).toBe("intro");

		editor.commands.undo();

		expect(markdownOf(editor)).toBe(before);
	});

	it("QB6: characters typed after a table action are not swallowed by its undo", () => {
		const editor = editorFromMarkdown(
			["| A | B |", "| --- | --- |", "| 1 | 2 |", "", "tail"].join("\n"),
		);

		editor.view.dispatch(
			requireTransaction(
				buildTransform(editor, (table) => moveTableColumn(table, 0, 1)),
			),
		);
		typeAtEndOfDocument(editor, "XY");
		expect(markdownOf(editor)).toContain("tailXY");

		editor.commands.undo();

		const afterFirstUndo = markdownOf(editor);
		expect(afterFirstUndo).not.toContain("tailXY");
		expect(afterFirstUndo).toContain("| B | A |");

		editor.commands.undo();

		expect(markdownOf(editor)).toContain("| A | B |");
	});
});

describe("no-op gestures dispatch nothing (R8)", () => {
	it("QA3: a move with nowhere to go produces no transaction at all", () => {
		const editor = editorFromMarkdown("| A |\n| --- |\n| 1 |");

		expect(
			buildTransform(editor, (table) => moveTableColumn(table, 0, 0)),
		).toBe(null);
		expect(buildTransform(editor, (table) => moveTableRow(table, 0, 1))).toBe(
			null,
		);
	});

	it("R16: a position that is not a table produces no transaction", () => {
		const editor = editorFromMarkdown("just a paragraph");

		expect(
			tableTransformTransaction(editor.state, 0, (table) =>
				deleteTableRow(table, 0),
			),
		).toBe(null);
	});
});

describe("save intent is re-marked at commit (R12, ruling R-H)", () => {
	it("PRE-1: every committed table transaction carries user edit intent", () => {
		const editor = editorFromMarkdown(
			["| A | B |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |"].join("\n"),
		);

		const transaction = requireTransaction(
			buildTransform(editor, (table) => moveTableColumn(table, 0, 1)),
		);

		expect(transactionCarriesUserEditIntent(transaction)).toBe(true);
	});

	it("PRE-1: an ordinary typing transaction does not carry the flag", () => {
		const editor = editorFromMarkdown("plain text");

		expect(transactionCarriesUserEditIntent(editor.state.tr)).toBe(false);
	});
});

describe("the caret survives (R15)", () => {
	it("QB9: a caret inside the deleted row lands somewhere valid", () => {
		const editor = editorFromMarkdown(
			["| A | B |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |"].join("\n"),
		);
		placeCaretAfterText(editor, "1");

		editor.view.dispatch(
			requireTransaction(
				buildTransform(editor, (table) => deleteTableRow(table, 0)),
			),
		);

		const { from } = editor.state.selection;
		expect(from).toBeGreaterThanOrEqual(0);
		expect(from).toBeLessThanOrEqual(editor.state.doc.content.size);
		expect(() => editor.state.doc.resolve(from)).not.toThrow();
		editor.state.doc.check();
	});

	it("QC7: a caret survives the whole table being removed", () => {
		const editor = editorFromMarkdown(
			["intro", "", "| A |", "| --- |", "| 1 |"].join("\n"),
		);
		placeCaretAfterText(editor, "1");

		editor.view.dispatch(
			requireTransaction(
				buildTransform(editor, (table) => deleteTableColumn(table, 0)),
			),
		);

		expect(() =>
			editor.state.doc.resolve(editor.state.selection.from),
		).not.toThrow();
		editor.state.doc.check();
	});
});

function buildTransform(
	editor: Editor,
	transform: Parameters<typeof tableTransformTransaction>[2],
): Transaction | null {
	const pos = tablePosition(editor);
	if (pos < 0) return null;
	return tableTransformTransaction(editor.state, pos, transform);
}

function requireTransaction(transaction: Transaction | null): Transaction {
	if (!transaction) throw new Error("Expected the transform to commit");
	return transaction;
}

function recordDispatchedTransactions(editor: Editor): Transaction[] {
	const seen: Transaction[] = [];
	editor.on("transaction", ({ transaction }) => {
		seen.push(transaction);
	});
	return seen;
}

function placeCaretAfterText(editor: Editor, text: string) {
	let position: number | null = null;
	editor.state.doc.descendants((node, pos) => {
		if (position === null && node.isText && node.text === text) {
			position = pos + node.nodeSize;
		}
		return position === null;
	});
	if (position === null) throw new Error(`Text not found: ${text}`);
	editor.view.dispatch(
		editor.state.tr.setSelection(
			TextSelection.create(editor.state.doc, position),
		),
	);
}

function typeAtEndOfDocument(editor: Editor, text: string) {
	const end = editor.state.doc.content.size - 1;
	editor.view.dispatch(
		editor.state.tr
			.setSelection(TextSelection.create(editor.state.doc, end))
			.insertText(text, end),
	);
}
