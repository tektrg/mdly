// @vitest-environment happy-dom
import type { JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import {
	commitTransform,
	destroyHarnessEditors,
	editorFromMarkdown,
	markdownOf,
	roundTripMarkdown,
	tablePosition,
} from "./__tests__/tableEditorHarness.js";
import {
	deleteTableColumn,
	deleteTableRow,
	moveTableColumn,
	moveTableRow,
	readTableShape,
	type TableTransformResult,
} from "./tableTransforms.js";

afterEach(destroyHarnessEditors);

const PLAIN_TABLE = [
	"| A | B | C |",
	"| --- | --- | --- |",
	"| 1 | 2 | 3 |",
	"| 4 | 5 | 6 |",
].join("\n");

describe("column move (R2)", () => {
	it("O2/EC2: carries the header, the cells and the alignment marker", () => {
		const editor = editorFromMarkdown(
			["| A | B | C |", "| --- | :---: | ---: |", "| 1 | 2 | 3 |"].join("\n"),
		);

		const { committed, markdown } = commitTransform(editor, (table) =>
			moveTableColumn(table, 0, 2),
		);

		expect(committed).toBe(true);
		expect(markdown).toBe(
			["| B | C | A |", "| :---: | ---: | --- |", "| 2 | 3 | 1 |"].join("\n"),
		);
	});

	it("EC2: a two-column swap moves both alignment markers", () => {
		const editor = editorFromMarkdown(
			["| A | B |", "| :--- | ---: |", "| 1 | 2 |"].join("\n"),
		);

		const { markdown } = commitTransform(editor, (table) =>
			moveTableColumn(table, 0, 1),
		);

		expect(markdown).toBe(
			["| B | A |", "| ---: | :--- |", "| 2 | 1 |"].join("\n"),
		);
	});

	it("REG-3: moving a column and moving it back is byte-identical", () => {
		const editor = editorFromMarkdown(PLAIN_TABLE);

		commitTransform(editor, (table) => moveTableColumn(table, 0, 2));
		const { markdown } = commitTransform(editor, (table) =>
			moveTableColumn(table, 2, 0),
		);

		expect(markdown).toBe(roundTripMarkdown(PLAIN_TABLE));
	});
});

describe("row move (R3, R7)", () => {
	it("O3: reorders body rows and leaves the header untouched", () => {
		const editor = editorFromMarkdown(
			[
				"| A | B |",
				"| --- | --- |",
				"| 1 | one |",
				"| 2 | two |",
				"| 3 | three |",
			].join("\n"),
		);

		const { committed, markdown } = commitTransform(editor, (table) =>
			moveTableRow(table, 2, 0),
		);

		expect(committed).toBe(true);
		expect(markdown).toBe(
			[
				"| A | B |",
				"| --- | --- |",
				"| 3 | three |",
				"| 1 | one |",
				"| 2 | two |",
			].join("\n"),
		);
	});

	it("EC5: a drop above the header is a no-op, not a throw", () => {
		const table = tableJson(PLAIN_TABLE);

		expect(moveTableRow(table, 0, -1)).toEqual({ kind: "unchanged" });
		expect(moveTableRow(table, -1, 0)).toEqual({ kind: "unchanged" });
	});

	it("QA2/R7: a row move on a header-only table does nothing", () => {
		const table = tableJson("| a | b |\n| --- | --- |");

		expect(readTableShape(table)).toEqual({ columnCount: 2, bodyRowCount: 0 });
		expect(moveTableRow(table, 0, 0)).toEqual({ kind: "unchanged" });
	});
});

describe("delete (R5, R7)", () => {
	it("O4: deleting a column re-emits the delimiter row at the new width", () => {
		const editor = editorFromMarkdown(PLAIN_TABLE);

		const { markdown } = commitTransform(editor, (table) =>
			deleteTableColumn(table, 1),
		);

		expect(markdown).toBe(
			["| A | C |", "| --- | --- |", "| 1 | 3 |", "| 4 | 6 |"].join("\n"),
		);
	});

	it("O4: deleting a body row leaves the rest of the table intact", () => {
		const editor = editorFromMarkdown(PLAIN_TABLE);

		const { markdown } = commitTransform(editor, (table) =>
			deleteTableRow(table, 0),
		);

		expect(markdown).toBe(
			["| A | B | C |", "| --- | --- | --- |", "| 4 | 5 | 6 |"].join("\n"),
		);
	});

	it("EC3: deleting the only column removes the whole table block", () => {
		const editor = editorFromMarkdown(
			["before", "", "| A |", "| --- |", "| 1 |", "", "after"].join("\n"),
		);

		const { committed, markdown } = commitTransform(editor, (table) =>
			deleteTableColumn(table, 0),
		);

		expect(committed).toBe(true);
		expect(markdown).not.toContain("|");
		expect(markdown).toBe("before\n\nafter");
		expect(tablePosition(editor)).toBe(-1);
	});

	it("EC4: deleting the last body row removes the whole table block", () => {
		const editor = editorFromMarkdown(
			["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n"),
		);

		const { markdown } = commitTransform(editor, (table) =>
			deleteTableRow(table, 0),
		);

		expect(markdown).not.toContain("|");
		expect(tablePosition(editor)).toBe(-1);
	});

	it("QA2/R7: deleting a header-only table's last column removes the table", () => {
		const editor = editorFromMarkdown("| only |\n| --- |");

		const { committed, markdown } = commitTransform(editor, (table) =>
			deleteTableColumn(table, 0),
		);

		expect(committed).toBe(true);
		expect(markdown).not.toContain("|");
	});
});

describe("ragged tables (R9, ruling R-F)", () => {
	const RAGGED = ["| A | B | C |", "| --- | --- | --- |", "| 1 | 2 |"].join(
		"\n",
	);

	it("O7: a ragged table's document is untouched until a transform commits", () => {
		// Ruling R-B: hovering, a dismissed menu and a cancelled drag must not
		// change the document, so nothing is ever saved and the file keeps its
		// ragged bytes. (An *ordinary* save already pads to the widest row —
		// `prosemirrorToMarkdown` computes the column count that way — which is
		// exactly why R-F calls squaring-off "the bytes the next save would have
		// written anyway".)
		const editor = editorFromMarkdown(RAGGED);
		const before = JSON.stringify(editor.getJSON());

		const { committed } = commitTransform(editor, (table) =>
			moveTableColumn(table, 1, 1),
		);

		expect(committed).toBe(false);
		expect(JSON.stringify(editor.getJSON())).toBe(before);
	});

	it("EC1: a column move squares the short row off and keeps both values", () => {
		const editor = editorFromMarkdown(RAGGED);

		const { markdown } = commitTransform(editor, (table) =>
			moveTableColumn(table, 0, 2),
		);

		expect(markdown).toBe(
			["| B | C | A |", "| --- | --- | --- |", "| 2 |  | 1 |"].join("\n"),
		);
	});

	it("EC8: a body row wider than the header pads the header, never trims", () => {
		const editor = editorFromMarkdown(
			["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n"),
		);
		appendCellToLastRow(editor, "keepme");

		const { markdown } = commitTransform(editor, (table) =>
			moveTableColumn(table, 0, 1),
		);

		expect(markdown).toContain("keepme");
		expect(markdown).toBe(
			["| B | A |  |", "| --- | --- | --- |", "| 2 | 1 | keepme |"].join("\n"),
		);
	});

	it("QB4/QA4: no transform result is ever an empty table", () => {
		const shapes = [
			PLAIN_TABLE,
			RAGGED,
			"| only |\n| --- |",
			"| a |\n| --- |\n| 1 |",
		];
		const transforms = [
			(table: ReturnType<typeof tableJson>) => moveTableColumn(table, 0, 1),
			(table: ReturnType<typeof tableJson>) => moveTableRow(table, 0, 1),
			(table: ReturnType<typeof tableJson>) => deleteTableColumn(table, 0),
			(table: ReturnType<typeof tableJson>) => deleteTableRow(table, 0),
		];

		for (const markdown of shapes) {
			for (const transform of transforms) {
				expectNeverAnEmptyTable(transform(tableJson(markdown)));
			}
		}
	});
});

describe("cell fidelity (R11)", () => {
	const TRICKY = [
		"| A | B |",
		"| --- | --- |",
		"| a \\| b | `code \\| pipe` |",
	].join("\n");

	it("EC9: escaped pipes and inline code survive a move and its inverse", () => {
		const editor = editorFromMarkdown(TRICKY);
		const before = markdownOf(editor);

		commitTransform(editor, (table) => moveTableColumn(table, 0, 1));
		const moved = markdownOf(editor);
		const { markdown } = commitTransform(editor, (table) =>
			moveTableColumn(table, 1, 0),
		);

		expect(markdown).toBe(before);
		// Two columns => three unescaped pipes per line, i.e. four split parts.
		// A cell's own pipe leaking out would raise this and split the column.
		for (const line of moved.split("\n")) {
			expect(line.split("\\|").join("").split("|")).toHaveLength(4);
		}
	});
});

describe("no-op gestures (R8)", () => {
	it("QA3: moving the only column or only row writes nothing", () => {
		const oneColumn = tableJson("| A |\n| --- |\n| 1 |");
		const oneRow = tableJson("| A | B |\n| --- | --- |\n| 1 | 2 |");

		expect(moveTableColumn(oneColumn, 0, 0)).toEqual({ kind: "unchanged" });
		expect(moveTableColumn(oneColumn, 0, 1)).toEqual({ kind: "unchanged" });
		expect(moveTableRow(oneRow, 0, 0)).toEqual({ kind: "unchanged" });
		expect(moveTableRow(oneRow, 0, 1)).toEqual({ kind: "unchanged" });
	});

	it("QA3: an out-of-range delete writes nothing", () => {
		const table = tableJson(PLAIN_TABLE);

		expect(deleteTableColumn(table, 3)).toEqual({ kind: "unchanged" });
		expect(deleteTableRow(table, 2)).toEqual({ kind: "unchanged" });
	});
});

describe("containers left valid (R6)", () => {
	it("QA1/QB5: a blockquote whose only block was a table keeps a paragraph", () => {
		const editor = editorFromMarkdown("> | A |\n> | --- |\n> | 1 |");

		const { markdown } = commitTransform(editor, (table) =>
			deleteTableColumn(table, 0),
		);

		expect(markdown).not.toContain("|");
		expect(editor.state.doc.firstChild?.type.name).toBe("blockquote");
		expect(editor.state.doc.firstChild?.childCount).toBe(1);
	});

	it("QA1/QC4: a toggle whose only body block was a table stays a toggle", () => {
		const editor = editorFromMarkdown(
			[
				"<details>",
				"<summary>Summary</summary>",
				"",
				"| A |",
				"| --- |",
				"| 1 |",
				"",
				"</details>",
			].join("\n"),
		);
		expect(editor.state.doc.firstChild?.type.name).toBe("toggle");

		const { markdown } = commitTransform(editor, (table) =>
			deleteTableColumn(table, 0),
		);

		expect(markdown).not.toContain("|");
		expect(editor.state.doc.firstChild?.type.name).toBe("toggle");
		expect(editor.state.doc).toBeDefined();
		editor.state.doc.check();
	});

	it("QC4: a table nested in another table's cell leaves the cell editable", () => {
		const editor = editorFromMarkdown(PLAIN_TABLE);
		nestTableInFirstCell(editor);

		const { committed } = commitTransform(
			editor,
			(table) => deleteTableColumn(table, 0),
			1,
		);

		expect(committed).toBe(true);
		editor.state.doc.check();
		expect(countTables(editor)).toBe(1);
	});

	it("EC19: deleting the document's only block leaves one empty paragraph", () => {
		const editor = editorFromMarkdown("| A |\n| --- |\n| 1 |");

		const { markdown } = commitTransform(editor, (table) =>
			deleteTableColumn(table, 0),
		);

		expect(markdown).toBe("");
		expect(editor.state.doc.childCount).toBe(1);
		expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
		editor.state.doc.check();
	});
});

function tableJson(markdown: string) {
	const editor = editorFromMarkdown(markdown);
	const json = editor.state.doc.nodeAt(0)?.toJSON();
	if (!json || json.type !== "table") {
		throw new Error(`No table parsed from: ${markdown}`);
	}
	return json;
}

function expectNeverAnEmptyTable(result: TableTransformResult) {
	if (result.kind !== "table") return;
	const rows = result.table.content ?? [];
	expect(rows.length).toBeGreaterThan(0);
	for (const row of rows) {
		expect((row.content ?? []).length).toBeGreaterThan(0);
	}
}

function countTables(editor: ReturnType<typeof editorFromMarkdown>): number {
	let count = 0;
	editor.state.doc.descendants((node) => {
		if (node.type.name === "table") count += 1;
		return true;
	});
	return count;
}

/** Produces a row wider than the header — only reachable by editing (R-F). */
function appendCellToLastRow(
	editor: ReturnType<typeof editorFromMarkdown>,
	text: string,
) {
	const json = editor.getJSON() as JSONContent;
	const table = json.content?.[0];
	const rows = table?.content ?? [];
	rows[rows.length - 1]?.content?.push({
		type: "tableCell",
		attrs: { align: null },
		content: [{ type: "paragraph", content: [{ type: "text", text }] }],
	});
	editor.commands.setContent(json);
}

/** Puts a second table inside the first table's first cell (R16/QC4 shape). */
function nestTableInFirstCell(editor: ReturnType<typeof editorFromMarkdown>) {
	const json = editor.getJSON() as JSONContent;
	const firstCell = json.content?.[0]?.content?.[0]?.content?.[0];
	if (!firstCell) throw new Error("No first cell to nest into");
	firstCell.content = [
		{
			type: "table",
			attrs: { uid: "nested-test-table" },
			content: [
				{
					type: "tableRow",
					content: [
						{
							type: "tableHeader",
							attrs: { align: null },
							content: [
								{ type: "paragraph", content: [{ type: "text", text: "N" }] },
							],
						},
					],
				},
			],
		},
	];
	editor.commands.setContent(json);
}
