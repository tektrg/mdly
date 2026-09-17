// @vitest-environment happy-dom
import type { JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";
import {
	destroyHarnessEditors,
	editorFromMarkdown,
	markdownOf,
	tablePosition,
} from "./__tests__/tableEditorHarness.js";
import {
	type CellPickTarget,
	cellPickTransaction,
	inferColumnValues,
	isPlainTextCell,
	pickTargetAtSelection,
} from "./inferredSelect.js";

afterEach(destroyHarnessEditors);

const STATUS_TABLE = [
	"| Task | Status |",
	"| --- | --- |",
	"| Write tests | Todo |",
	"| Fix bug | Doing |",
	"| Ship | Done |",
	"| Review | Todo |",
].join("\n");

function tableJson(markdown: string): JSONContent {
	const editor = editorFromMarkdown(markdown);
	const json = editor.state.doc.nodeAt(0)?.toJSON();
	if (!json || json.type !== "table") {
		throw new Error(`No table parsed from: ${markdown}`);
	}
	return json;
}

function cellJson(
	markdown: string,
	bodyRow: number,
	column: number,
): JSONContent {
	const table = tableJson(markdown);
	const row = table.content?.[bodyRow + 1];
	const cell = row?.content?.[column];
	if (!cell) throw new Error("Cell not found in fixture");
	return cell;
}

type LiveEditor = ReturnType<typeof editorFromMarkdown>;

/** Absolute positions of every cell in the first table, row-major. */
function cellPositions(editor: LiveEditor): {
	tablePos: number;
	cells: number[];
} {
	const tablePos = tablePosition(editor);
	const table = editor.state.doc.nodeAt(tablePos);
	if (!table) throw new Error("No table in fixture");
	const cells: number[] = [];
	table.descendants((node, pos) => {
		if (node.type.name === "tableCell" || node.type.name === "tableHeader") {
			cells.push(tablePos + 1 + pos);
		}
		return true;
	});
	return { tablePos, cells };
}

function targetFor(
	editor: LiveEditor,
	bodyRow: number,
	column: number,
	columnCount: number,
): CellPickTarget {
	const { tablePos, cells } = cellPositions(editor);
	const cellPos = cells[(bodyRow + 1) * columnCount + column];
	if (cellPos === undefined) throw new Error("Cell not found in fixture");
	return { tablePos, cellPos, columnIndex: column };
}

/** A pick target derived the way the UI derives it: from a live selection. */
function targetFromSelection(
	editor: LiveEditor,
	bodyRow: number,
	column: number,
	columnCount: number,
): CellPickTarget {
	const target = targetFor(editor, bodyRow, column, columnCount);
	editor.view.dispatch(
		editor.state.tr.setSelection(
			TextSelection.near(editor.state.doc.resolve(target.cellPos + 1)),
		),
	);
	const resolved = pickTargetAtSelection(editor.state);
	if (!resolved) throw new Error("No pick target at selection");
	return resolved;
}

function pickIn(
	markdown: string,
	bodyRow: number,
	column: number,
	columnCount: number,
	value: string,
): { committed: boolean; markdown: string } {
	const editor = editorFromMarkdown(markdown);
	const target = targetFor(editor, bodyRow, column, columnCount);
	const transaction = cellPickTransaction(editor.state, target, value);
	const committed = transaction !== null;
	if (transaction) editor.view.dispatch(transaction);
	return { committed, markdown: markdownOf(editor) };
}

describe("inference helper (R26)", () => {
	it("O11: returns the column's distinct values in first-appearance order", () => {
		const table = tableJson(STATUS_TABLE);
		expect(inferColumnValues(table, 1)).toEqual(["Todo", "Doing", "Done"]);
		expect(inferColumnValues(table, 0)).toEqual([
			"Write tests",
			"Fix bug",
			"Ship",
			"Review",
		]);
	});

	it("O11: returns nothing for a non-qualifying column", () => {
		const rows = Array.from(
			{ length: 12 },
			(_, index) => `| Task ${index} | Value ${index} |`,
		);
		const table = tableJson(
			["| Task | Status |", "| --- | --- |", ...rows].join("\n"),
		);
		expect(inferColumnValues(table, 1)).toEqual([]);
	});

	it("rejects an out-of-range column without throwing", () => {
		const table = tableJson(STATUS_TABLE);
		expect(inferColumnValues(table, 5)).toEqual([]);
		expect(inferColumnValues(table, -1)).toEqual([]);
	});
});

describe("threshold boundaries (R27, O12/EC13)", () => {
	function tableWithValues(values: string[]): JSONContent {
		const rows = values.map((value) => `| ${value} |`);
		return tableJson(["| Status |", "| --- |", ...rows].join("\n"));
	}

	it("9 distinct values with a 19-char maximum qualify", () => {
		const values = Array.from({ length: 9 }, (_, index) =>
			`value-${index}-x`.padEnd(19, "y"),
		);
		expect(values[0]).toHaveLength(19);
		expect(inferColumnValues(tableWithValues(values), 0)).toEqual(values);
	});

	it("exactly 10 distinct values offer nothing", () => {
		const values = Array.from({ length: 10 }, (_, index) => `v${index}`);
		expect(inferColumnValues(tableWithValues(values), 0)).toEqual([]);
	});

	it("a value of exactly 20 characters disqualifies the column", () => {
		expect(
			inferColumnValues(tableWithValues(["Todo", "x".repeat(20)]), 0),
		).toEqual([]);
		expect(
			inferColumnValues(tableWithValues(["Todo", "x".repeat(19)]), 0),
		).toEqual(["Todo", "x".repeat(19)]);
	});

	it("R-E: no minimum row count — every column of a 3-row table qualifies", () => {
		const table = tableJson(
			["| A | B |", "| --- | --- |", "| 1 | x |", "| 2 | y |"].join("\n"),
		);
		expect(inferColumnValues(table, 0)).toEqual(["1", "2"]);
		expect(inferColumnValues(table, 1)).toEqual(["x", "y"]);
	});

	it("duplicates collapse to one offer", () => {
		expect(
			inferColumnValues(tableWithValues(["Todo", "Todo", "Done"]), 0),
		).toEqual(["Todo", "Done"]);
	});
});

describe("blank handling (R28, QA11)", () => {
	it("an all-blank column offers no chevron", () => {
		const table = tableJson(
			["| A | B |", "| --- | --- |", "| 1 |  |", "| 2 |  |"].join("\n"),
		);
		expect(inferColumnValues(table, 1)).toEqual([]);
	});

	it("blanks are never options and whitespace-only differences count once", () => {
		const table = tableJson(
			[
				"| Status |",
				"| --- |",
				"| Done |",
				"|   Done   |",
				"|  |",
				"| Todo |",
			].join("\n"),
		);
		expect(inferColumnValues(table, 0)).toEqual(["Done", "Todo"]);
	});

	it("a 9-value column still qualifies despite blanks around it", () => {
		const values = Array.from({ length: 9 }, (_, index) => `v${index}`);
		const rows = ["|  |", ...values.map((value) => `| ${value} |`), "|   |"];
		const table = tableJson(["| S |", "| --- |", ...rows].join("\n"));
		expect(inferColumnValues(table, 0)).toEqual(values);
	});
});

describe("plain-text gate (R29, QA12)", () => {
	it("plain text and blank cells pass; link, bold, italic and code do not", () => {
		expect(isPlainTextCell(cellJson(STATUS_TABLE, 0, 1))).toBe(true);
		expect(isPlainTextCell(cellJson("| A |\n| --- |\n|  |", 0, 0))).toBe(true);
		expect(
			isPlainTextCell(cellJson("| A |\n| --- |\n| [x](https://y.z) |", 0, 0)),
		).toBe(false);
		expect(isPlainTextCell(cellJson("| A |\n| --- |\n| **x** |", 0, 0))).toBe(
			false,
		);
		expect(isPlainTextCell(cellJson("| A |\n| --- |\n| *x* |", 0, 0))).toBe(
			false,
		);
		expect(isPlainTextCell(cellJson("| A |\n| --- |\n| `x` |", 0, 0))).toBe(
			false,
		);
	});

	it("a split cell of plain paragraphs still passes the gate (R32 collapses it)", () => {
		const cell: JSONContent = {
			type: "tableCell",
			content: [
				{ type: "paragraph", content: [{ type: "text", text: "one" }] },
				{ type: "paragraph", content: [{ type: "text", text: "two" }] },
			],
		};
		expect(isPlainTextCell(cell)).toBe(true);
	});
});

describe("selection targeting", () => {
	it("resolves the table, cell and column from a caret in a cell", () => {
		const editor = editorFromMarkdown(STATUS_TABLE);
		const { tablePos } = cellPositions(editor);
		const target = targetFromSelection(editor, 1, 1, 2);
		expect(target.tablePos).toBe(tablePos);
		expect(target.columnIndex).toBe(1);
		const cell = editor.state.doc.nodeAt(target.cellPos);
		expect(cell?.type.name).toBe("tableCell");
		expect(cell?.textContent).toBe("Doing");
	});

	it("returns null when the caret is outside any table", () => {
		const editor = editorFromMarkdown(`Hello\n\n${STATUS_TABLE}`);
		editor.view.dispatch(
			editor.state.tr.setSelection(
				TextSelection.near(editor.state.doc.resolve(1)),
			),
		);
		expect(pickTargetAtSelection(editor.state)).toBeNull();
	});
});

describe("cell pick transaction (R31, R32, R12)", () => {
	it("QB10: picking the value the cell already holds writes nothing", () => {
		const { committed, markdown } = pickIn(STATUS_TABLE, 0, 1, 2, "Todo");
		expect(committed).toBe(false);
		expect(markdown).toBe(
			[
				"| Task | Status |",
				"| --- | --- |",
				"| Write tests | Todo |",
				"| Fix bug | Doing |",
				"| Ship | Done |",
				"| Review | Todo |",
			].join("\n"),
		);
	});

	it("R26: picking a listed value fills the cell", () => {
		const { committed, markdown } = pickIn(STATUS_TABLE, 1, 1, 2, "Done");
		expect(committed).toBe(true);
		expect(markdown).toContain("| Fix bug | Done |");
	});

	it("QB11: a pick on a split cell leaves exactly one paragraph", () => {
		const editor = editorFromMarkdown(STATUS_TABLE);
		const json = editor.getJSON() as JSONContent;
		const cell = json.content?.[0]?.content?.[2]?.content?.[1];
		if (!cell) throw new Error("Cell not found in fixture");
		cell.content = [
			{ type: "paragraph", content: [{ type: "text", text: "Do" }] },
			{ type: "paragraph", content: [{ type: "text", text: "ing" }] },
		];
		editor.commands.setContent(json);
		const target = targetFor(editor, 1, 1, 2);
		const transaction = cellPickTransaction(editor.state, target, "Done");
		expect(transaction).not.toBeNull();
		if (transaction) editor.view.dispatch(transaction);
		const after = editor.getJSON() as JSONContent;
		const picked = after.content?.[0]?.content?.[2]?.content?.[1];
		if (!picked) throw new Error("Picked cell vanished");
		expect(picked.content).toHaveLength(1);
		expect(picked.content?.[0]?.content).toEqual([
			{ type: "text", text: "Done" },
		]);
	});

	it("R29: a pick on a formatted cell writes nothing", () => {
		const { committed } = pickIn(
			"| A |\n| --- |\n| **Todo** |",
			0,
			0,
			1,
			"Done",
		);
		expect(committed).toBe(false);
	});

	it("R12: the pick transaction carries user-edit intent", () => {
		const editor = editorFromMarkdown(STATUS_TABLE);
		const target = targetFor(editor, 1, 1, 2);
		const transaction = cellPickTransaction(editor.state, target, "Done");
		expect(transaction?.getMeta("mdlyUserEditIntent")).toBe(true);
	});
});
