// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { DecorationSet } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubbleCodeBlock } from "./CodeBlockExtension";

const editors: Editor[] = [];

afterEach(() => {
	for (const editor of editors) editor.destroy();
	editors.length = 0;
});

describe("code block editor extension", () => {
	it("inserts two spaces for Tab inside TypeScript code blocks", () => {
		const editor = createCodeBlockEditor();

		expect(editor.commands.keyboardShortcut("Tab")).toBe(true);

		expect(editor.getJSON().content?.[0]).toMatchObject({
			type: "codeBlock",
			attrs: { language: "ts" },
			content: [{ type: "text", text: "const x = 1;  " }],
		});
	});

	it("deletes a two-space soft-tab segment for TypeScript", () => {
		const editor = createCodeBlockEditor("  const x = 1;", 3);

		expect(editor.commands.keyboardShortcut("Backspace")).toBe(true);

		expect(editor.getJSON().content?.[0]).toMatchObject({
			type: "codeBlock",
			attrs: { language: "ts" },
			content: [{ type: "text", text: "const x = 1;" }],
		});
	});

	it("deletes trailing soft-tab spaces at a tab stop", () => {
		const editor = createCodeBlockEditor("const x = 1;  ", 15);

		expect(editor.commands.keyboardShortcut("Backspace")).toBe(true);

		expect(editor.getJSON().content?.[0]).toMatchObject({
			type: "codeBlock",
			attrs: { language: "ts" },
			content: [{ type: "text", text: "const x = 1;" }],
		});
	});

	it("uses four-space indents for Python code blocks", () => {
		const editor = createCodeBlockEditor("print('ok')", undefined, "python");

		expect(editor.commands.keyboardShortcut("Tab")).toBe(true);

		expect(editor.getJSON().content?.[0]).toMatchObject({
			type: "codeBlock",
			attrs: { language: "python" },
			content: [{ type: "text", text: "print('ok')    " }],
		});
	});
});

describe("code block highlighting cost (large-document editing lag)", () => {
	it("registers exactly one Lowlight plugin", () => {
		const { editor } = createHighlightEditor();
		expect(lowlightPluginCount(editor)).toBe(1);
	});

	it("rehighlights only the edited block, not every code block", () => {
		const { editor, highlight, highlightAuto } = createHighlightEditor();
		clearHighlightMocks(highlight, highlightAuto);

		// Real typing carries the selection inside the edited code block.
		const textPos = codeBlockTextPos(editor, 0);
		editor.view.dispatch(
			editor.state.tr.setSelection(
				TextSelection.create(editor.state.doc, textPos),
			),
		);
		editor.view.dispatch(editor.state.tr.insertText("x", textPos));

		expect(highlight.mock.calls.length + highlightAuto.mock.calls.length).toBe(
			1,
		);
		expect(lowlightDecorationCount(editor)).toBeGreaterThan(0);
	});

	it("does not rehighlight on prose edits outside code blocks", () => {
		const { editor, highlight, highlightAuto } = createHighlightEditor();
		clearHighlightMocks(highlight, highlightAuto);

		editor.view.dispatch(editor.state.tr.insertText("x", 2));

		expect(highlight).not.toHaveBeenCalled();
		expect(highlightAuto).not.toHaveBeenCalled();
	});

	it("does no highlight work for selection-only transactions", () => {
		const { editor, highlight, highlightAuto } = createHighlightEditor();
		const before = lowlightDecorationCount(editor);
		expect(before).toBeGreaterThan(0);
		clearHighlightMocks(highlight, highlightAuto);

		editor.view.dispatch(
			editor.state.tr.setSelection(
				TextSelection.create(editor.state.doc, codeBlockTextPos(editor, 1)),
			),
		);

		expect(highlight).not.toHaveBeenCalled();
		expect(highlightAuto).not.toHaveBeenCalled();
		expect(lowlightDecorationCount(editor)).toBe(before);
	});

	it("invalidates a block touched by a programmatic edit while the selection is elsewhere", () => {
		const { editor, highlight, highlightAuto } = createHighlightEditor();
		clearHighlightMocks(highlight, highlightAuto);

		// Selection stays in the prose paragraph; the edit lands strictly
		// inside the second code block (find-replace / collab shape).
		const textPos = codeBlockTextPos(editor, 1);
		editor.view.dispatch(editor.state.tr.insertText("x", textPos));

		expect(highlight.mock.calls.length + highlightAuto.mock.calls.length).toBe(
			1,
		);
		expect(lowlightDecorationCount(editor)).toBeGreaterThan(0);
	});

	it("rehighlights a block whose language changed and keeps decorations", () => {
		const { editor, highlight, highlightAuto } = createHighlightEditor();
		clearHighlightMocks(highlight, highlightAuto);

		const block = findCodeBlocks(editor.state.doc)[0];
		if (!block) throw new Error("Expected a code block");
		editor.view.dispatch(
			editor.state.tr.setNodeMarkup(block.pos, undefined, {
				...block.node.attrs,
				language: "python",
			}),
		);

		expect(highlight.mock.calls.length + highlightAuto.mock.calls.length).toBe(
			1,
		);
		expect(lowlightDecorationCount(editor)).toBeGreaterThan(0);
	});

	it("keeps decorations correct through undo without rehighlighting unchanged text", () => {
		const { editor, highlight, highlightAuto } = createHighlightEditor();
		const before = editor.state.doc.textContent;
		clearHighlightMocks(highlight, highlightAuto);

		const textPos = codeBlockTextPos(editor, 0);
		editor.view.dispatch(
			editor.state.tr.setSelection(
				TextSelection.create(editor.state.doc, textPos),
			),
		);
		editor.view.dispatch(editor.state.tr.insertText("x", textPos));
		expect(editor.commands.undo()).toBe(true);
		expect(editor.state.doc.textContent).toBe(before);

		// The undone text matches a cached highlight result, so no new
		// highlight work is needed, but decorations must still be present.
		expect(highlight.mock.calls.length + highlightAuto.mock.calls.length).toBe(
			1,
		);
		expect(lowlightDecorationCount(editor)).toBeGreaterThan(0);
	});

	it("highlights pasted code blocks once with decorations", () => {
		const { editor, highlight, highlightAuto } = createHighlightEditor();
		clearHighlightMocks(highlight, highlightAuto);

		expect(
			editor
				.chain()
				.focus()
				.insertContent({
					type: "codeBlock",
					attrs: { language: "javascript" },
					content: [{ type: "text", text: "const pasted = true;" }],
				})
				.run(),
		).toBe(true);

		expect(highlight.mock.calls.length + highlightAuto.mock.calls.length).toBe(
			1,
		);
		expect(lowlightDecorationCount(editor)).toBeGreaterThan(0);
	});
});

function createCodeBlockEditor(
	text = "const x = 1;",
	cursorPos?: number,
	language = "ts",
) {
	const editor = new Editor({
		element: document.createElement("div"),
		extensions: [StarterKit.configure({ codeBlock: false }), HubbleCodeBlock],
		content: {
			type: "doc",
			content: [
				{
					type: "codeBlock",
					attrs: { language },
					content: [{ type: "text", text }],
				},
			],
		},
	});
	editors.push(editor);
	Object.defineProperty(editor, "isFocused", { value: true });
	const codeBlock = editor.state.doc.firstChild;
	if (!codeBlock) throw new Error("Expected code block");
	editor.view.dispatch(
		editor.state.tr.setSelection(
			TextSelection.create(
				editor.state.doc,
				cursorPos ?? codeBlock.nodeSize - 1,
			),
		),
	);
	return editor;
}

function createHighlightEditor() {
	const baseLowlight = HubbleCodeBlock.options.lowlight;
	const highlight = vi.fn((language: string, value: string) =>
		baseLowlight.highlight(language, value),
	);
	const highlightAuto = vi.fn((value: string) =>
		baseLowlight.highlightAuto(value),
	);
	const instrumented = HubbleCodeBlock.configure({
		lowlight: { ...baseLowlight, highlight, highlightAuto },
	});
	const editor = new Editor({
		element: document.createElement("div"),
		extensions: [StarterKit.configure({ codeBlock: false }), instrumented],
		content: {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [{ type: "text", text: "Intro prose." }],
				},
				...["const alpha = 1;", "const beta = 2;", "const gamma = 3;"].map(
					(text) => ({
						type: "codeBlock",
						attrs: { language: "javascript" },
						content: [{ type: "text", text }],
					}),
				),
			],
		},
	});
	editors.push(editor);
	return { editor, highlight, highlightAuto };
}

function clearHighlightMocks(
	highlight: ReturnType<typeof vi.fn>,
	highlightAuto: ReturnType<typeof vi.fn>,
) {
	highlight.mockClear();
	highlightAuto.mockClear();
}

// Tiptap 3 exposes the plugin key as a plain string at runtime (e.g.
// "lowlight$"); tolerate a PluginKey instance too, the same way the
// investigation fixtures match by prefix.
function isLowlightPlugin(plugin: Editor["state"]["plugins"][number]) {
	const key = (plugin as unknown as { key?: unknown }).key;
	const name =
		typeof key === "string"
			? key
			: (key as { key?: unknown } | null | undefined)?.key;
	return typeof name === "string" && name.startsWith("lowlight");
}

function lowlightPluginCount(editor: Editor) {
	return editor.state.plugins.filter(isLowlightPlugin).length;
}

function lowlightDecorationCount(editor: Editor) {
	const plugin = editor.state.plugins.find(isLowlightPlugin);
	if (!plugin) throw new Error("Expected the Lowlight plugin");
	const decorations = plugin.getState(editor.state) as DecorationSet;
	return decorations.find().length;
}

function findCodeBlocks(doc: ProseMirrorNode) {
	const blocks: { pos: number; node: ProseMirrorNode }[] = [];
	doc.descendants((node, pos) => {
		if (node.type.name === "codeBlock") blocks.push({ pos, node });
	});
	return blocks;
}

function codeBlockTextPos(editor: Editor, index: number) {
	const block = findCodeBlocks(editor.state.doc)[index];
	if (!block) throw new Error("Expected a code block");
	return block.pos + 1;
}
