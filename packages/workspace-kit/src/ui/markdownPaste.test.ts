// @vitest-environment happy-dom

import { Editor, type JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { listExtensions, toggleBlockExtensions } from "../engine/index.js";
import {
	handleMarkdownTextPaste,
	hasMarkdownSyntax,
	hasSemanticHtml,
} from "./markdownPaste";

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

function pasteEvent(text: string, html = ""): ClipboardEvent {
	return {
		clipboardData: {
			getData: (type: string) => {
				if (type === "text/plain") return text;
				if (type === "text/html") return html;
				return "";
			},
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

	it("leaves internal ProseMirror copy with data-pm-slice unhandled", () => {
		const editor = createEditor(docWithParagraph(""));
		const handled = handleMarkdownTextPaste(
			editor,
			pasteEvent(
				"# Copied heading",
				'<h1 data-pm-slice="0 0 []">Copied heading</h1>',
			),
		);
		expect(handled).toBe(false);
	});

	it("leaves external rich HTML with no markdown syntax unhandled", () => {
		const editor = createEditor(docWithParagraph(""));
		const handled = handleMarkdownTextPaste(
			editor,
			pasteEvent(
				"Browser Heading\nSome strong text and a link",
				'<h2>Browser Heading</h2><p>Some <strong>strong text</strong> and <a href="https://example.com">a link</a></p>',
			),
		);
		expect(handled).toBe(false);
	});

	it("leaves external rich HTML containing snake_case variables unhandled", () => {
		const editor = createEditor(docWithParagraph(""));
		const handled = handleMarkdownTextPaste(
			editor,
			pasteEvent(
				"Title with user_profile_data\nVariable user_account_id is active",
				"<h3>Title with user_profile_data</h3><p>Variable <code>user_account_id</code> is active</p>",
			),
		);
		expect(handled).toBe(false);
	});

	it("leaves external rich HTML containing links with classes unhandled", () => {
		const editor = createEditor(docWithParagraph(""));
		const handled = handleMarkdownTextPaste(
			editor,
			pasteEvent(
				"link text",
				'<p><a class="btn-primary external-link" target="_blank" href="https://example.com">link text</a></p>',
			),
		);
		expect(handled).toBe(false);
	});

	it("leaves plain text with no markdown syntax unhandled so default ProseMirror handler runs", () => {
		const editor = createEditor(docWithParagraph(""));
		const handled = handleMarkdownTextPaste(
			editor,
			pasteEvent("Just a plain sentence with no formatting."),
		);
		expect(handled).toBe(false);
	});

	it("reinterprets markdown when plain text has markdown syntax even if wrapped in div HTML", () => {
		const editor = createEditor(docWithParagraph(""));
		const handled = handleMarkdownTextPaste(
			editor,
			pasteEvent(
				"## VS Code Heading\n- Item 1",
				'<div style="color: red;"><span>## VS Code Heading</span><br><span>- Item 1</span></div>',
			),
		);
		expect(handled).toBe(true);
		expect(editor.getJSON()).toMatchObject({
			type: "doc",
			content: [
				{ type: "heading", attrs: { level: 2 } },
				{ type: "bulletList" },
				{ type: "paragraph" },
			],
		});
	});
});

describe("markdown syntax and semantic HTML detectors", () => {
	it("detects common markdown syntax correctly", () => {
		expect(hasMarkdownSyntax("# Title")).toBe(true);
		expect(hasMarkdownSyntax("### Subtitle")).toBe(true);
		expect(hasMarkdownSyntax("- bullet")).toBe(true);
		expect(hasMarkdownSyntax("1. numbered")).toBe(true);
		expect(hasMarkdownSyntax("- [ ] task")).toBe(true);
		expect(hasMarkdownSyntax("> quote")).toBe(true);
		expect(hasMarkdownSyntax("```ts\ncode\n```")).toBe(true);
		expect(hasMarkdownSyntax("here is `inline code`")).toBe(true);
		expect(hasMarkdownSyntax("this is **bold** text")).toBe(true);
		expect(hasMarkdownSyntax("this is *italic* text")).toBe(true);
		expect(hasMarkdownSyntax("this is _italic_ text")).toBe(true);
		expect(hasMarkdownSyntax("this is __bold__ text")).toBe(true);
		expect(hasMarkdownSyntax("this is ~~strike~~ text")).toBe(true);
		expect(hasMarkdownSyntax("[link](https://example.com)")).toBe(true);
		expect(hasMarkdownSyntax("[[WikiLink]]")).toBe(true);
		expect(hasMarkdownSyntax("| col 1 | col 2 |")).toBe(true);
		expect(hasMarkdownSyntax("<details><summary>t</summary></details>")).toBe(
			true,
		);
		expect(hasMarkdownSyntax("---")).toBe(true);

		expect(hasMarkdownSyntax("Plain sentence with no formatting.")).toBe(false);
		expect(hasMarkdownSyntax("Math: 2 * 3 = 6 and 4 _ 5")).toBe(false);
		expect(hasMarkdownSyntax("user_profile_data")).toBe(false);
		expect(hasMarkdownSyntax("const my_first_var_name = 123;")).toBe(false);
		expect(hasMarkdownSyntax("")).toBe(false);
	});

	it("detects semantic HTML tags vs plain divs/spans", () => {
		expect(hasSemanticHtml("<h2>Heading</h2>")).toBe(true);
		expect(hasSemanticHtml("<b>bold</b>")).toBe(true);
		expect(hasSemanticHtml("<strong>strong</strong>")).toBe(true);
		expect(hasSemanticHtml("<em>italic</em>")).toBe(true);
		expect(hasSemanticHtml("<ul><li>item</li></ul>")).toBe(true);
		expect(hasSemanticHtml("<table><tr><td>cell</td></tr></table>")).toBe(true);
		expect(hasSemanticHtml('<a href="https://example.com">link</a>')).toBe(
			true,
		);
		expect(
			hasSemanticHtml(
				'<a class="custom-class" target="_blank" href="https://example.com">link</a>',
			),
		).toBe(true);
		expect(hasSemanticHtml('<a name="anchor-without-href">anchor</a>')).toBe(
			false,
		);
		expect(hasSemanticHtml("<pre><code>code</code></pre>")).toBe(true);

		expect(hasSemanticHtml("<div><span>plain text in span</span></div>")).toBe(
			false,
		);
		expect(hasSemanticHtml("plain text")).toBe(false);
	});
});
