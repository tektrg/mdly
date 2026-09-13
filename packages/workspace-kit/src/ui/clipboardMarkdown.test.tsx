// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	listExtensions,
	sliceToMarkdown,
	tableExtensions,
	toggleBlockExtensions,
} from "../engine/index.js";
import { EditorView, type EditorViewProps } from "./EditorView";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const standaloneEditors: Editor[] = [];

afterEach(() => {
	for (const ed of standaloneEditors) ed.destroy();
	standaloneEditors.length = 0;
});

function createStandaloneEditor(content: Record<string, unknown>) {
	const editor = new Editor({
		element: document.createElement("div"),
		extensions: [
			StarterKit.configure({ listItem: false }),
			...listExtensions,
			...tableExtensions,
			...toggleBlockExtensions,
		],
		content,
	});
	standaloneEditors.push(editor);
	return editor;
}

describe("sliceToMarkdown clipboard serialization", () => {
	it("serializes a heading node selection to markdown with hashes", () => {
		const editor = createStandaloneEditor({
			type: "doc",
			content: [
				{
					type: "heading",
					attrs: { level: 2 },
					content: [{ type: "text", text: "Subheading" }],
				},
			],
		});

		editor.view.dispatch(
			editor.state.tr.setSelection(
				TextSelection.create(editor.state.doc, 1, 11),
			),
		);
		const slice = editor.state.selection.content();
		expect(sliceToMarkdown(slice)).toBe("## Subheading");
	});

	it("serializes bold inline text to markdown with asterisks", () => {
		const editor = createStandaloneEditor({
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{ type: "text", text: "Hello " },
						{ type: "text", text: "bold world", marks: [{ type: "bold" }] },
					],
				},
			],
		});

		// Select "bold world"
		editor.view.dispatch(
			editor.state.tr.setSelection(
				TextSelection.create(editor.state.doc, 7, 17),
			),
		);
		const slice = editor.state.selection.content();
		expect(sliceToMarkdown(slice)).toBe("**bold world**");
	});

	it("serializes a bullet list to markdown list syntax", () => {
		const editor = createStandaloneEditor({
			type: "doc",
			content: [
				{
					type: "bulletList",
					content: [
						{
							type: "listItem",
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "First" }],
								},
							],
						},
						{
							type: "listItem",
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "Second" }],
								},
							],
						},
					],
				},
			],
		});

		editor.view.dispatch(
			editor.state.tr.setSelection(
				TextSelection.create(editor.state.doc, 3, 18),
			),
		);
		const slice = editor.state.selection.content();
		expect(sliceToMarkdown(slice)).toBe("- First\n- Second");
	});

	it("serializes text inside a code block as raw code text without fences", () => {
		const editor = createStandaloneEditor({
			type: "doc",
			content: [
				{
					type: "codeBlock",
					attrs: { language: "typescript" },
					content: [{ type: "text", text: "const x = 1;\nconst y = 2;" }],
				},
			],
		});

		editor.view.dispatch(
			editor.state.tr.setSelection(
				TextSelection.create(editor.state.doc, 1, 13),
			),
		);
		const slice = editor.state.selection.content();
		expect(sliceToMarkdown(slice)).toBe("const x = 1;");
	});

	it("serializes multiple paragraphs joined with blank lines", () => {
		const editor = createStandaloneEditor({
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [{ type: "text", text: "First paragraph" }],
				},
				{
					type: "paragraph",
					content: [{ type: "text", text: "Second paragraph" }],
				},
			],
		});

		editor.view.dispatch(
			editor.state.tr.setSelection(
				TextSelection.create(
					editor.state.doc,
					1,
					editor.state.doc.content.size - 1,
				),
			),
		);
		const slice = editor.state.selection.content();
		expect(sliceToMarkdown(slice)).toBe("First paragraph\n\nSecond paragraph");
	});
});

describe("EditorView copy/paste integration", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function mountEditor(initialMarkdown: string): Promise<Editor> {
		return new Promise((resolve) => {
			const props: EditorViewProps = {
				path: "/workspace/note.md",
				initialMarkdown,
				onLocalChange: vi.fn(),
				onSave: vi.fn(),
				onOpenExternalLink: vi.fn(),
				onOpenWikiLink: vi.fn(),
				onEditorReady: (editor) => {
					if (editor) resolve(editor);
				},
			};
			act(() => {
				root.render(<EditorView {...props} />);
			});
		});
	}

	it("provides a clipboardTextSerializer that produces markdown on copy", async () => {
		const editor = await mountEditor(
			"# Hello Heading\n\nThis is **bold** text.\n",
		);

		const headingPos = 1;
		const headingEnd = headingPos + "Hello Heading".length;
		editor.view.dispatch(
			editor.state.tr.setSelection(
				TextSelection.create(editor.state.doc, headingPos, headingEnd),
			),
		);

		const slice = editor.state.selection.content();
		const serializer = editor.view.someProp(
			"clipboardTextSerializer",
			(fn) => fn,
		);

		expect(serializer).toBeDefined();
		const text = serializer?.(slice, editor.view);
		expect(text).toBe("# Hello Heading");
	});

	it("preserves rich HTML with no markdown syntax instead of flattening to plain text", async () => {
		const editor = await mountEditor("");

		const clipboardData = {
			getData: (format: string) => {
				if (format === "text/html") {
					return '<h2>Browser Heading</h2><p>Here is <strong>strong text</strong> and <a href="https://example.com">a link</a>.</p>';
				}
				if (format === "text/plain") {
					return "Browser Heading\nHere is strong text and a link.";
				}
				return "";
			},
			types: ["text/html", "text/plain"],
		};

		const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(pasteEvent, "clipboardData", {
			value: clipboardData,
		});

		act(() => {
			editor.view.dom.dispatchEvent(pasteEvent);
		});

		const json = editor.getJSON();
		const heading = json.content?.find((node) => node.type === "heading");
		expect(heading).toBeDefined();
		expect(heading?.attrs?.level).toBe(2);
	});
});
