// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { markdownToTiptapDoc, tiptapDocToMarkdown } from "../engine/index.js";
import { createTableUid } from "../engine/tableUid.js";
import {
	commitTransform,
	destroyHarnessEditors,
	editorFromMarkdown,
	markdownOf,
} from "./__tests__/tableEditorHarness.js";
import { moveTableColumn } from "./tableTransforms.js";

afterEach(destroyHarnessEditors);

const TABLE = ["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n");

/** Charter R24 / ruling D3 — the session id is invisible everywhere but memory. */
describe("per-table session id (R24)", () => {
	it("EC11: never appears in the rendered DOM, so never in clipboard HTML", () => {
		const editor = editorFromMarkdown(TABLE);
		const table = editor.view.dom.querySelector("table");

		expect(editor.state.doc.firstChild?.attrs.uid).toEqual(expect.any(String));
		expect(table).not.toBeNull();
		expect(table?.getAttribute("uid")).toBeNull();
		expect(editor.getHTML()).not.toContain("uid");
	});

	it("QA15: a copy pasted back as markdown becomes an independent table", () => {
		const editor = editorFromMarkdown(TABLE);
		const original = editor.state.doc.firstChild?.attrs.uid;

		// mdly copies tables out as Markdown text, so a paste re-parses.
		const pastedCopy = markdownToTiptapDoc(markdownOf(editor));

		expect(pastedCopy.content?.[0]?.attrs?.uid).toEqual(expect.any(String));
		expect(pastedCopy.content?.[0]?.attrs?.uid).not.toBe(original);
	});

	it("R24: the id survives a committed transform, so session state is not reset", () => {
		const editor = editorFromMarkdown(TABLE);
		const before = editor.state.doc.firstChild?.attrs.uid;

		const { committed, markdown } = commitTransform(editor, (table) =>
			moveTableColumn(table, 0, 1),
		);

		expect(committed).toBe(true);
		expect(editor.state.doc.firstChild?.attrs.uid).toBe(before);
		expect(markdown).not.toContain(String(before));
	});

	it("R24: every minted id is unique", () => {
		const ids = new Set(Array.from({ length: 500 }, createTableUid));

		expect(ids.size).toBe(500);
	});

	it("EC11: a document that was never given ids saves the same bytes", () => {
		const parsed = markdownToTiptapDoc(TABLE);
		const table = parsed.content?.[0];
		if (table) table.attrs = { uid: null };

		expect(tiptapDocToMarkdown(parsed)).toBe(TABLE);
	});
});
