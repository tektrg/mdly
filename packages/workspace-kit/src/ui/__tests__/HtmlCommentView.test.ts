// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { markdownToTiptapDoc } from "../../engine/markdownToProsemirror";
import {
	sliceToMarkdown,
	tiptapDocToMarkdown,
} from "../../engine/prosemirrorToMarkdown";
import { htmlCommentViewExtensions } from "../HtmlCommentView";

const NOTE = "<!-- CHECKED: source says x -->";
const editors: Editor[] = [];

afterEach(() => {
	for (const editor of editors) editor.destroy();
	editors.length = 0;
	for (const el of document.querySelectorAll("[data-html-comment-popover]")) {
		el.remove();
	}
});

function setup(markdown: string) {
	const element = document.createElement("div");
	document.body.append(element);
	const editor = new Editor({
		element,
		extensions: [StarterKit, ...htmlCommentViewExtensions],
		content: markdownToTiptapDoc(markdown),
	});
	editors.push(editor);
	return editor;
}

const md = (editor: Editor) => tiptapDocToMarkdown(editor.getJSON());
const marker = () =>
	document.querySelector<HTMLElement>("[data-html-comment-marker]");
const popover = () =>
	document.querySelector<HTMLElement>("[data-html-comment-popover]");

/** Doc position of the first htmlComment node. */
function commentPos(editor: Editor): number {
	let found = -1;
	editor.state.doc.descendants((node, pos) => {
		if (found < 0 && node.type.name.startsWith("htmlComment")) found = pos;
	});
	return found;
}

describe("inline comment marker", () => {
	it("shows only a marker, labelled with the note, keyboard focusable", () => {
		setup(`Claim. ${NOTE} Next.`);
		const el = marker();
		expect(el).not.toBeNull();
		expect(el?.getAttribute("aria-label")).toBe("Note: CHECKED: source says x");
		expect(el?.getAttribute("title")).toBe("CHECKED: source says x");
		expect(el?.getAttribute("tabindex")).toBe("0");
		expect(el?.getAttribute("role")).toBe("button");
		expect(document.querySelector(".ProseMirror")?.textContent).not.toContain(
			"CHECKED",
		);
	});

	it("is one cursor step: a single-size atom", () => {
		const editor = setup(`a ${NOTE} b`);
		const node = editor.state.doc.nodeAt(commentPos(editor));
		expect(node?.type.name).toBe("htmlComment");
		expect(node?.nodeSize).toBe(1);
		expect(node?.isAtom).toBe(true);
	});

	it("Backspace deletes it as a unit and undo restores the bytes", () => {
		const source = `a ${NOTE} b`;
		const editor = setup(source);
		const after = commentPos(editor) + 1;
		editor.commands.setTextSelection(after);
		editor.commands.keyboardShortcut("Backspace");
		expect(md(editor)).toBe("a  b");
		expect(editor.state.selection.from).toBe(after - 1);
		editor.commands.undo();
		expect(md(editor)).toBe(source);
	});

	it("Delete in front of it removes it as a unit", () => {
		const editor = setup(`a ${NOTE} b`);
		editor.commands.setTextSelection(commentPos(editor));
		editor.commands.keyboardShortcut("Delete");
		expect(md(editor)).toBe("a  b");
	});

	it("copying surrounding text carries the comment", () => {
		const editor = setup(`- Claim ${NOTE} next`);
		const start = commentPos(editor) - "Claim ".length;
		const end = commentPos(editor) + 1 + " next".length;
		// What a real copy serializes: the selection's slice, wrappers included.
		editor.commands.setTextSelection({ from: start, to: end });
		const slice = editor.state.selection.content();
		expect(sliceToMarkdown(slice)).toBe(`Claim ${NOTE} next`);
	});

	it("click opens a popover with the full note, Escape closes it", () => {
		setup(`a ${NOTE} b`);
		marker()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(popover()?.textContent).toContain("CHECKED: source says x");
		popover()?.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
		);
		expect(popover()).toBeNull();
	});

	it("Enter on the focused marker opens the popover", () => {
		setup(`a ${NOTE} b`);
		marker()?.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
		);
		expect(popover()).not.toBeNull();
	});

	it("Enter with the node selected opens the popover", () => {
		const editor = setup(`a ${NOTE} b`);
		editor.view.dispatch(
			editor.state.tr.setSelection(
				NodeSelection.create(editor.state.doc, commentPos(editor)),
			),
		);
		editor.commands.keyboardShortcut("Enter");
		expect(popover()).not.toBeNull();
		expect(md(editor)).toBe(`a ${NOTE} b`);
	});

	it("edit saves back as <!-- … --> keeping padding, undoable", () => {
		const editor = setup(`a ${NOTE} b`);
		marker()?.click();
		popover()
			?.querySelector<HTMLButtonElement>("[data-html-comment-edit]")
			?.click();
		const textarea = popover()?.querySelector("textarea");
		expect(textarea?.value).toBe("CHECKED: source says x");
		if (textarea) textarea.value = "new note";
		popover()
			?.querySelector<HTMLButtonElement>("[data-html-comment-save]")
			?.click();
		expect(md(editor)).toBe("a <!-- new note --> b");
		expect(popover()).toBeNull();
		expect(marker()?.getAttribute("title")).toBe("new note");
		editor.commands.undo();
		expect(md(editor)).toBe(`a ${NOTE} b`);
	});

	it("rejects --> on edit and leaves the document unchanged", () => {
		const editor = setup(`a ${NOTE} b`);
		marker()?.click();
		popover()
			?.querySelector<HTMLButtonElement>("[data-html-comment-edit]")
			?.click();
		const textarea = popover()?.querySelector("textarea");
		if (textarea) textarea.value = "bad --> text";
		popover()
			?.querySelector<HTMLButtonElement>("[data-html-comment-save]")
			?.click();
		expect(
			popover()?.querySelector("[data-html-comment-error]")?.textContent,
		).toContain("-->");
		expect(md(editor)).toBe(`a ${NOTE} b`);
	});

	it("Cmd+Enter in the edit box saves", () => {
		const editor = setup(`a ${NOTE} b`);
		marker()?.click();
		popover()
			?.querySelector<HTMLButtonElement>("[data-html-comment-edit]")
			?.click();
		const textarea = popover()?.querySelector("textarea");
		if (textarea) textarea.value = "via shortcut";
		textarea?.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Enter",
				metaKey: true,
				bubbles: true,
			}),
		);
		expect(md(editor)).toBe("a <!-- via shortcut --> b");
	});
});

describe("block comment marker", () => {
	it("renders a marker for a multi-line block and edits it", () => {
		const editor = setup("# H\n\n<!--\nline one\nline two\n-->\n\nPara");
		expect(marker()?.getAttribute("title")).toBe("line one\nline two");
		marker()?.click();
		popover()
			?.querySelector<HTMLButtonElement>("[data-html-comment-edit]")
			?.click();
		const textarea = popover()?.querySelector("textarea");
		if (textarea) textarea.value = "only";
		popover()
			?.querySelector<HTMLButtonElement>("[data-html-comment-save]")
			?.click();
		expect(md(editor)).toBe("# H\n\n<!--\nonly\n-->\n\nPara");
	});
});
