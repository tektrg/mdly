// @vitest-environment happy-dom

import { Editor, type JSONContent, Node } from "@tiptap/core";
import { BulletList, ListItem, OrderedList } from "@tiptap/extension-list";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { columnsExtensions, MermaidBlockExtension } from "../engine/index.js";
import {
	applySlashCommand,
	findSlashToken,
	type SlashToken,
} from "./slashCommandActions";

const editors: Editor[] = [];
const CheckedListItem = ListItem.extend({
	addAttributes() {
		return {
			checked: {
				default: null,
			},
		};
	},
});

afterEach(() => {
	for (const editor of editors) editor.destroy();
	editors.length = 0;
});

describe("slash command token detection", () => {
	it("detects slash commands at the start of a text block", () => {
		const editor = createEditor(docWithParagraph("/h"));

		expect(findSlashToken(editor)).toMatchObject({ query: "h" });
	});

	it("detects slash commands after whitespace", () => {
		const editor = createEditor(docWithParagraph("hello /h"));

		expect(findSlashToken(editor)).toMatchObject({ query: "h" });
	});

	it("does not detect slash commands inside phrases or paths", () => {
		expect(findSlashToken(createEditor(docWithParagraph("hello/there")))).toBe(
			null,
		);
		expect(findSlashToken(createEditor(docWithParagraph("docs/foo")))).toBe(
			null,
		);
	});
});

describe("slash command document actions", () => {
	it("converts an empty slash paragraph in place", () => {
		const editor = createEditor(docWithParagraph("/h2"));
		const token = expectSlashToken(editor);

		applySlashCommand(editor, token, "heading2");

		expect(editor.getJSON()).toMatchObject({
			type: "doc",
			content: [
				{ type: "heading", attrs: { level: 2 } },
				{ type: "paragraph" },
			],
		});
	});

	it("inserts a new block after non-empty slash paragraphs", () => {
		const editor = createEditor(docWithParagraph("text /h2"));
		const token = expectSlashToken(editor);

		applySlashCommand(editor, token, "heading2");

		expect(editor.getJSON()).toMatchObject({
			type: "doc",
			content: [
				{ type: "paragraph", content: [{ type: "text", text: "text " }] },
				{ type: "heading", attrs: { level: 2 } },
				{ type: "paragraph" },
			],
		});
	});

	it("creates unchecked task list items", () => {
		const editor = createEditor(docWithParagraph("/todo"));
		const token = expectSlashToken(editor);

		applySlashCommand(editor, token, "taskList");

		expect(editor.getJSON()).toMatchObject({
			type: "doc",
			content: [
				{
					type: "bulletList",
					content: [
						{
							type: "listItem",
							attrs: { checked: false },
							content: [{ type: "paragraph" }],
						},
					],
				},
				{ type: "paragraph" },
			],
		});
	});

	it("inserts a paragraph after a divider", () => {
		const editor = createEditor(docWithParagraph("/divider"));
		const token = expectSlashToken(editor);

		applySlashCommand(editor, token, "divider");

		expect(editor.getJSON()).toMatchObject({
			type: "doc",
			content: [{ type: "horizontalRule" }, { type: "paragraph" }],
		});
	});

	it("inserts a mermaid diagram with a trailing paragraph", () => {
		const editor = createEditor(docWithParagraph("/mermaid"));
		const token = expectSlashToken(editor);

		applySlashCommand(editor, token, "mermaid");

		expect(editor.getJSON()).toMatchObject({
			type: "doc",
			content: [
				{ type: "mermaidBlock", attrs: { raw: expect.any(String) } },
				{ type: "paragraph" },
			],
		});
	});

	it("toggles strikethrough for following typed text", () => {
		const editor = createEditor(docWithParagraph("/strike"));
		const token = expectSlashToken(editor);

		applySlashCommand(editor, token, "strike");

		editor.commands.insertContent("next");
		expect(editor.getJSON()).toMatchObject({
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{
							type: "text",
							text: "next",
							marks: [{ type: "strike" }],
						},
					],
				},
			],
		});
	});
});

const TestEmbed = Node.create({
	name: "embed",
	group: "block",
	atom: true,
	addAttributes() {
		return {
			kind: { default: "iframe" },
			src: { default: "" },
			raw: { default: null },
			width: { default: null },
			height: { default: null },
		};
	},
	renderHTML: ({ node }) => ["iframe", { src: node.attrs.src }],
});

const EMBED_ATTRS = {
	kind: "iframe",
	src: "https://a.com/x",
	raw: '<iframe src="https://a.com/x"></iframe>',
	width: null,
	height: null,
};

function createEditor(content: JSONContent) {
	const editor = new Editor({
		element: document.createElement("div"),
		extensions: [
			StarterKit.configure({
				bulletList: false,
				orderedList: false,
				listItem: false,
			}),
			BulletList,
			OrderedList,
			CheckedListItem,
			MermaidBlockExtension,
			...columnsExtensions,
			TestEmbed,
		],
		content,
	});
	editors.push(editor);
	Object.defineProperty(editor, "isFocused", { value: true });
	editor.view.dispatch(
		editor.state.tr.setSelection(
			TextSelection.create(editor.state.doc, editor.state.doc.content.size - 1),
		),
	);
	return editor;
}

describe("/embed and /image slash commands", () => {
	it("/embed in an empty paragraph replaces it with the embed + caret paragraph", () => {
		const editor = createEditor(docWithParagraph("/embed"));
		applySlashCommand(editor, expectSlashToken(editor), "embed", {
			embedAttrs: EMBED_ATTRS,
		});
		expect(editor.getJSON().content).toMatchObject([
			{ type: "embed", attrs: { src: "https://a.com/x" } },
			{ type: "paragraph" },
		]);
	});

	it("/embed after text inserts the embed below and removes the token", () => {
		const editor = createEditor(docWithParagraph("hello /embed"));
		applySlashCommand(editor, expectSlashToken(editor), "embed", {
			embedAttrs: EMBED_ATTRS,
		});
		expect(editor.getJSON().content).toMatchObject([
			{ type: "paragraph", content: [{ type: "text", text: "hello " }] },
			{ type: "embed" },
			{ type: "paragraph" },
		]);
	});

	it("/embed inside a column stays inside that column", () => {
		const editor = createEditor({
			type: "doc",
			content: [
				{
					type: "columns",
					content: [
						{
							type: "column",
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "/embed" }],
								},
							],
						},
						{ type: "column", content: [{ type: "paragraph" }] },
					],
				},
			],
		});
		editor.view.dispatch(
			editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 9)),
		);
		applySlashCommand(editor, expectSlashToken(editor), "embed", {
			embedAttrs: EMBED_ATTRS,
		});
		const doc: JSONContent = editor.getJSON();
		// (the columns schema may append a trailing paragraph after the group)
		expect(doc.content?.[0]?.type).toBe("columns");
		expect(doc.content?.slice(1).some((n) => n.type === "embed")).toBe(false);
		expect(doc.content?.[0]?.content?.[0]?.content).toMatchObject([
			{ type: "embed" },
			{ type: "paragraph" },
		]);
	});

	it("/embed without attrs is a no-op", () => {
		const editor = createEditor(docWithParagraph("/embed"));
		applySlashCommand(editor, expectSlashToken(editor), "embed");
		const doc: JSONContent = editor.getJSON();
		expect(doc.content?.[0]?.content?.[0]?.text).toBe("/embed");
	});

	it("/image removes the token and hands the caret to the host", () => {
		const editor = createEditor(docWithParagraph("/image"));
		let called = 0;
		applySlashCommand(editor, expectSlashToken(editor), "image", {
			onInsertImage: () => called++,
		});
		expect(called).toBe(1);
		expect(editor.getJSON().content).toEqual([{ type: "paragraph" }]);
	});
});

function expectSlashToken(editor: Editor): SlashToken {
	const token = findSlashToken(editor);
	expect(token).not.toBeNull();
	if (!token) throw new Error("Expected slash token");
	return token;
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
