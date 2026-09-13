// @vitest-environment happy-dom

import { Editor, type JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { toggleBlockExtensions } from "../engine/index.js";

const editors: Editor[] = [];

afterEach(() => {
	for (const editor of editors) editor.destroy();
	editors.length = 0;
});

describe("toggle summary Enter", () => {
	it("moves the cursor into the first body block", () => {
		const editor = createEditor({
			type: "doc",
			content: [
				{
					type: "toggle",
					content: [
						{
							type: "toggleSummary",
							content: [{ type: "text", text: "Title" }],
						},
						{
							type: "paragraph",
							content: [{ type: "text", text: "Body" }],
						},
					],
				},
			],
		});
		placeCursorAfterText(editor, "Title");

		pressEnter(editor);

		const { $from } = editor.state.selection;
		expect($from.parent.type.name).toBe("paragraph");
		expect($from.parent.textContent).toBe("Body");
		// Cursor lands at the start of the body block, ready to type.
		expect($from.parentOffset).toBe(0);
	});

	it("leaves Enter alone outside a summary", () => {
		const editor = createEditor({
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [{ type: "text", text: "Plain" }],
				},
			],
		});
		placeCursorAfterText(editor, "Plain");

		pressEnter(editor);

		expect(editor.getJSON().content).toHaveLength(2);
	});
});

function createEditor(content: JSONContent) {
	const editor = new Editor({
		element: document.createElement("div"),
		extensions: [StarterKit, ...toggleBlockExtensions],
		content,
	});
	editors.push(editor);
	Object.defineProperty(editor, "isFocused", { value: true });
	return editor;
}

function placeCursorAfterText(editor: Editor, text: string) {
	let position: number | null = null;
	editor.state.doc.descendants((node, pos) => {
		if (node.isText && node.text === text) {
			position = pos + node.nodeSize;
			return false;
		}
	});
	if (position === null) throw new Error(`Text not found: ${text}`);
	editor.view.dispatch(
		editor.state.tr.setSelection(
			TextSelection.create(editor.state.doc, position),
		),
	);
}

// A real keydown through the view's prop chain — the same path production
// typing takes. (`commands.keyboardShortcut` wraps dispatch in a captured
// transaction that swallows the nested selection-only dispatch, so it cannot
// observe handlers whose whole effect is moving the cursor.)
function pressEnter(editor: Editor) {
	editor.view.someProp("handleKeyDown", (handler) =>
		handler(
			editor.view,
			new KeyboardEvent("keydown", {
				key: "Enter",
				bubbles: true,
				cancelable: true,
			}),
		),
	);
}
