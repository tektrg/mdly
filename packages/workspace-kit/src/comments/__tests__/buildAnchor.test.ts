// @vitest-environment happy-dom

import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { buildQuoteAnchor } from "../buildAnchor";

const editors: Editor[] = [];

afterEach(() => {
	for (const editor of editors) editor.destroy();
	editors.length = 0;
});

const DOC: JSONContent = {
	type: "doc",
	content: [
		{
			type: "paragraph",
			content: [{ type: "text", text: "Hello brave new world" }],
		},
	],
};

function createEditor() {
	const editor = new Editor({
		element: document.createElement("div"),
		extensions: [StarterKit],
		content: DOC,
	});
	editors.push(editor);
	return editor;
}

describe("buildQuoteAnchor", () => {
	it("captures the exact selected text as the quote, always in quote mode", () => {
		const editor = createEditor();
		// Position 1 is the start of the paragraph's text content; "Hello" spans 5 chars.
		const anchor = buildQuoteAnchor(editor.state.doc, 1, 6);

		expect(anchor.mode).toBe("quote");
		expect(anchor.quote).toBe("Hello");
		expect(anchor.from).toBe(1);
		expect(anchor.to).toBe(6);
		expect(anchor.contextAfter).toBe(" brave new world");
		expect(anchor.contextBefore).toBe("");
	});

	it("captures surrounding context on both sides for a mid-document selection", () => {
		const editor = createEditor();
		// "brave" starts right after "Hello " (6 chars in), spans 5 chars.
		const anchor = buildQuoteAnchor(editor.state.doc, 7, 12);

		expect(anchor.quote).toBe("brave");
		expect(anchor.contextBefore).toBe("Hello ");
		expect(anchor.contextAfter).toBe(" new world");
	});

	it("clamps context at the document boundary instead of throwing", () => {
		const editor = createEditor();
		// docSize (content.size) counts the paragraph's closing token as its
		// own unit, so the position right after the last character is
		// docSize - 1, not docSize.
		const endOfText = editor.state.doc.content.size - 1;
		const anchor = buildQuoteAnchor(editor.state.doc, endOfText - 5, endOfText);

		expect(anchor.quote).toBe("world");
		expect(anchor.contextAfter).toBe("");
	});
});
