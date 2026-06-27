// @vitest-environment happy-dom

import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import {
	findDocumentTextMatches,
	findStringMatches,
	replaceAllEditorMatches,
	replaceAllStringMatches,
	replaceEditorMatch,
	replaceStringMatch,
	selectEditorMatch,
} from "./findReplace";

const editors: Editor[] = [];

afterEach(() => {
	for (const editor of editors) editor.destroy();
	editors.length = 0;
	document.body.replaceChildren();
});

describe("findStringMatches", () => {
	it("finds case-insensitive matches by default", () => {
		expect(
			findStringMatches("Alpha alpha", "alpha", { caseSensitive: false }),
		).toEqual([
			{ from: 0, to: 5, text: "Alpha" },
			{ from: 6, to: 11, text: "alpha" },
		]);
	});

	it("respects case-sensitive matching", () => {
		expect(
			findStringMatches("Alpha alpha", "alpha", { caseSensitive: true }),
		).toEqual([{ from: 6, to: 11, text: "alpha" }]);
	});
});

describe("findDocumentTextMatches", () => {
	it("returns ProseMirror text positions for rendered document text", () => {
		const editor = createEditor({
			type: "doc",
			content: [paragraph("Alpha"), paragraph("beta Alpha")],
		});

		expect(
			findDocumentTextMatches(editor.state.doc, "alpha", {
				caseSensitive: false,
			}),
		).toEqual([
			{ from: 1, to: 6, text: "Alpha" },
			{ from: 13, to: 18, text: "Alpha" },
		]);
	});
});

describe("replace helpers", () => {
	it("replaces one string match", () => {
		const text = "title: Alpha";
		const [match] = findStringMatches(text, "alpha", {
			caseSensitive: false,
		});

		expect(replaceStringMatch(text, match, "Beta")).toBe("title: Beta");
	});

	it("replaces all string matches from the end to preserve offsets", () => {
		const text = "Alpha alpha";
		const matches = findStringMatches(text, "alpha", {
			caseSensitive: false,
		});

		expect(replaceAllStringMatches(text, matches, "Beta")).toBe("Beta Beta");
	});

	it("replaces one editor match", () => {
		const editor = createEditor(docWithParagraph("Alpha alpha"));
		const [match] = findDocumentTextMatches(editor.state.doc, "alpha", {
			caseSensitive: false,
		});

		replaceEditorMatch(editor, match, "Beta");

		expect(editor.getText()).toBe("Beta alpha");
	});

	it("supports repeated editor replacement after length-changing edits", () => {
		const editor = createEditor(docWithParagraph("Alpha alpha"));
		const options = { caseSensitive: false };
		const [firstMatch] = findDocumentTextMatches(
			editor.state.doc,
			"alpha",
			options,
		);

		replaceEditorMatch(editor, firstMatch, "B");
		const [secondMatch] = findDocumentTextMatches(
			editor.state.doc,
			"alpha",
			options,
		);
		replaceEditorMatch(editor, secondMatch, "B");

		expect(editor.getText()).toBe("B B");
	});

	it("replaces all editor matches from the end to preserve positions", () => {
		const editor = createEditor(docWithParagraph("Alpha alpha"));
		const matches = findDocumentTextMatches(editor.state.doc, "alpha", {
			caseSensitive: false,
		});

		replaceAllEditorMatches(editor, matches, "Beta");

		expect(editor.getText()).toBe("Beta Beta");
	});
});

describe("selectEditorMatch", () => {
	it("keeps focus in the current control while updating the editor selection", () => {
		const searchInput = document.createElement("input");
		document.body.append(searchInput);
		searchInput.focus();
		const editor = createEditor(docWithParagraph("Alpha alpha"));
		const [match] = findDocumentTextMatches(editor.state.doc, "alpha", {
			caseSensitive: false,
		});

		selectEditorMatch(editor, match);

		expect(document.activeElement).toBe(searchInput);
		expect(editor.state.selection.from).toBe(match.from);
		expect(editor.state.selection.to).toBe(match.to);
	});
});

function createEditor(content: JSONContent) {
	const element = document.createElement("div");
	document.body.append(element);
	const editor = new Editor({
		element,
		extensions: [StarterKit],
		content,
	});
	editors.push(editor);
	return editor;
}

function docWithParagraph(text: string): JSONContent {
	return {
		type: "doc",
		content: [paragraph(text)],
	};
}

function paragraph(text: string): JSONContent {
	return {
		type: "paragraph",
		content: text ? [{ type: "text", text }] : undefined,
	};
}
