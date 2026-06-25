// @vitest-environment happy-dom

import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { collectTableOfContentsHeadings } from "./TableOfContents";

const editors: Editor[] = [];

afterEach(() => {
	for (const editor of editors) editor.destroy();
	editors.length = 0;
});

describe("collectTableOfContentsHeadings", () => {
	it("collects every heading level with document progress", () => {
		const editor = createEditor({
			type: "doc",
			content: [
				{
					type: "heading",
					attrs: { level: 1 },
					content: [{ type: "text", text: "Title" }],
				},
				{
					type: "paragraph",
					content: [{ type: "text", text: "Intro" }],
				},
				{
					type: "heading",
					attrs: { level: 4 },
					content: [{ type: "text", text: "Details" }],
				},
				{
					type: "heading",
					attrs: { level: 6 },
				},
			],
		});

		expect(collectTableOfContentsHeadings(editor.state.doc)).toEqual([
			expect.objectContaining({
				id: "heading-0",
				level: 1,
				pos: 0,
				title: "Title",
				progress: 0,
			}),
			expect.objectContaining({
				level: 4,
				title: "Details",
			}),
			expect.objectContaining({
				level: 6,
				title: "Heading 6",
			}),
		]);
	});
});

function createEditor(content: JSONContent) {
	const editor = new Editor({
		element: document.createElement("div"),
		extensions: [StarterKit],
		content,
	});
	editors.push(editor);
	return editor;
}
