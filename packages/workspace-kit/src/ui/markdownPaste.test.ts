// @vitest-environment happy-dom

import { Editor, type JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { listExtensions, toggleBlockExtensions } from "../engine/index.js";
import { handleMarkdownTextPaste } from "./markdownPaste";

const editors: Editor[] = [];

afterEach(() => {
	for (const editor of editors) editor.destroy();
	editors.length = 0;
});

function createEditor(content: JSONContent) {
	const editor = new Editor({
		element: document.createElement("div"),
		extensions: [
			StarterKit.configure({ listItem: false }),
			...listExtensions,
			...toggleBlockExtensions,
		],
		content,
	});
	editors.push(editor);
	editor.view.dispatch(
		editor.state.tr.setSelection(
			TextSelection.create(editor.state.doc, editor.state.doc.content.size - 1),
		),
	);
	return editor;
}

function docWithParagraph(text: string): JSONContent {
	return {
		type: "doc",
		content: [
			{
				type: "paragraph",
				content: text ? [{ type: "text", text }] : undefined,
			},
		],
	};
}

function pasteEvent(text: string): ClipboardEvent {
	return {
		clipboardData: {
			getData: (type: string) => (type === "text/plain" ? text : ""),
		},
	} as unknown as ClipboardEvent;
}

describe("smart-paste: plain text is interpreted as markdown", () => {
	it("converts a pasted <details> block into a toggle node", () => {
		const editor = createEditor(docWithParagraph(""));

		const handled = handleMarkdownTextPaste(
			editor,
			pasteEvent(
				"<details>\n<summary>**Bold title**</summary>\n## Heading\n- One\n- Two\n</details>",
			),
		);

		expect(handled).toBe(true);
		expect(editor.getJSON()).toMatchObject({
			type: "doc",
			content: [
				{
					type: "toggle",
					content: [
						{
							type: "toggleSummary",
							content: [
								{ type: "text", text: "Bold title", marks: [{ type: "bold" }] },
							],
						},
						{ type: "heading", attrs: { level: 2 } },
						{ type: "bulletList" },
					],
				},
				{ type: "paragraph" },
			],
		});
	});

	it("merges a single-paragraph paste into the surrounding paragraph", () => {
		const editor = createEditor(docWithParagraph("Hello "));

		const handled = handleMarkdownTextPaste(editor, pasteEvent("**world**"));

		expect(handled).toBe(true);
		expect(editor.getJSON()).toMatchObject({
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{ type: "text", text: "Hello " },
						{ type: "text", text: "world", marks: [{ type: "bold" }] },
					],
				},
			],
		});
	});

	it("leaves an empty clipboard unhandled", () => {
		const editor = createEditor(docWithParagraph(""));

		expect(handleMarkdownTextPaste(editor, pasteEvent(""))).toBe(false);
	});

	it("does not reinterpret markdown syntax pasted into a code block", () => {
		// createEditor already places the cursor at the end of the initial
		// content (inside the code block); a second dispatch here would
		// recompute the position against the doc's post-append size (Tiptap
		// auto-appends a trailing empty paragraph after a non-paragraph last
		// node) and land outside the code block instead.
		const editor = createEditor({
			type: "doc",
			content: [
				{ type: "codeBlock", content: [{ type: "text", text: "x = 1" }] },
			],
		});

		expect(
			handleMarkdownTextPaste(editor, pasteEvent("## not a heading")),
		).toBe(false);
	});
});
