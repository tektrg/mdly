// @vitest-environment happy-dom

import { Editor, type JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CommentExtension,
	pendingCommentAnchorKey,
	setPendingCommentAnchor,
} from "../comments/CommentExtension";
import { MarkdownRolloverExtension } from "../engine/MarkdownRolloverExtension";
import { multiSelectionLabel, multiSelectionSummary } from "./FindReplaceBar";
import {
	getMultiSelectionRanges,
	MultiSelectionExtension,
	multiSelectionKey,
	normalizeRanges,
} from "./MultiSelectionExtension";

const editors: Editor[] = [];

afterEach(() => {
	for (const editor of editors) editor.destroy();
	editors.length = 0;
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

function paragraph(text: string): JSONContent {
	return { type: "paragraph", content: text ? [{ type: "text", text }] : [] };
}

function createEditor(...texts: string[]) {
	const element = document.createElement("div");
	document.body.append(element);
	const editor = new Editor({
		element,
		extensions: [
			StarterKit,
			MultiSelectionExtension,
			MarkdownRolloverExtension,
			CommentExtension,
		],
		content: { type: "doc", content: texts.map(paragraph) },
	});
	editors.push(editor);
	return editor;
}

function key(editor: Editor, keyName: string, init: KeyboardEventInit = {}) {
	const event = new KeyboardEvent("keydown", { key: keyName, ...init });
	let handled = false;
	editor.view.someProp("handleKeyDown", (f) => {
		if (!handled && f(editor.view, event)) handled = true;
		return handled || undefined;
	});
	return handled;
}

function cmdD(editor: Editor) {
	return key(editor, "d", { metaKey: true });
}

function type(editor: Editor, text: string) {
	const { from, to } = editor.state.selection;
	const handled = editor.view.someProp("handleTextInput", (f) =>
		f(editor.view, from, to, text, () => editor.state.tr),
	);
	if (!handled) editor.view.dispatch(editor.state.tr.insertText(text));
}

function caret(editor: Editor, pos: number) {
	editor.view.dispatch(
		editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)),
	);
}

const texts = (editor: Editor) =>
	getMultiSelectionRanges(editor.state).map((r) =>
		editor.state.doc.textBetween(
			Math.min(r.anchor, r.head),
			Math.max(r.anchor, r.head),
		),
	);
const heads = (editor: Editor) =>
	getMultiSelectionRanges(editor.state).map((r) => r.head);

describe("Cmd+D", () => {
	it("expands a caret to its word, then adds whole-word matches with wrap and dedupe", () => {
		const editor = createEditor("foo foobar foo", "foo");
		caret(editor, 2); // inside first "foo"
		expect(cmdD(editor)).toBe(true);
		expect(texts(editor)).toEqual(["foo"]);
		expect(multiSelectionKey.getState(editor.state)?.wholeWord).toBe(true);
		cmdD(editor);
		cmdD(editor);
		// "foobar" skipped (whole word); third "foo" in para 2.
		expect(getMultiSelectionRanges(editor.state)).toHaveLength(3);
		expect(texts(editor)).toEqual(["foo", "foo", "foo"]);
		cmdD(editor); // nothing new left: wrap finds only taken ranges
		expect(getMultiSelectionRanges(editor.state)).toHaveLength(3);
	});

	it("with a selection, adds the next case-sensitive substring match and wraps to top", () => {
		const editor = createEditor("ab AB xab ab");
		editor.view.dispatch(
			editor.state.tr.setSelection(
				TextSelection.create(editor.state.doc, 11, 13),
			),
		);
		cmdD(editor); // wraps to first "ab"
		cmdD(editor); // "xab" substring match (not whole-word mode)
		expect(getMultiSelectionRanges(editor.state).map((r) => r.anchor)).toEqual([
			1, 8, 11,
		]);
	});

	it("Cmd+Shift+L selects every occurrence", () => {
		const editor = createEditor("a cat, a cat", "cat");
		caret(editor, 4);
		key(editor, "l", { metaKey: true, shiftKey: true });
		expect(texts(editor)).toEqual(["cat", "cat", "cat"]);
	});
});

describe("editing at all ranges", () => {
	it("types at N ranges in one transaction and one undo step", () => {
		const editor = createEditor("foo x foo", "foo");
		caret(editor, 2);
		cmdD(editor);
		cmdD(editor);
		cmdD(editor);
		const dispatch = vi.spyOn(editor.view, "dispatch");
		type(editor, "bar");
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("bar x bar\n\nbar");
		expect(heads(editor)).toEqual([4, 10, 15]);
		editor.commands.undo();
		expect(editor.getText()).toBe("foo x foo\n\nfoo");
		expect(getMultiSelectionRanges(editor.state)).toHaveLength(0);
	});

	it("keeps marks at each range", () => {
		const editor = createEditor("x");
		editor.commands.setContent({
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{ type: "text", text: "go", marks: [{ type: "bold" }] },
						{ type: "text", text: " go" },
					],
				},
			],
		});
		editor.view.dispatch(
			editor.state.tr.setSelection(
				TextSelection.create(editor.state.doc, 1, 3),
			),
		);
		cmdD(editor);
		type(editor, "run");
		const json = editor.getJSON().content?.[0]?.content;
		expect(json?.[0]).toEqual({
			type: "text",
			text: "run",
			marks: [{ type: "bold" }],
		});
		expect(json?.[1]).toEqual({ type: "text", text: " run" });
	});

	it("Backspace/Delete edit every caret without joining blocks", () => {
		const editor = createEditor("ab ab", "ab");
		caret(editor, 2);
		cmdD(editor);
		cmdD(editor);
		cmdD(editor);
		key(editor, "ArrowLeft"); // carets at start of each "ab"
		key(editor, "Backspace"); // first caret at block start: no join
		expect(editor.getText()).toBe("abab\n\nab");
		key(editor, "Delete");
		expect(editor.getText()).toBe("bb\n\nb");
	});

	it("merges ranges that become overlapping", () => {
		expect(
			normalizeRanges(
				[
					{ anchor: 5, head: 5 },
					{ anchor: 2, head: 5 },
					{ anchor: 9, head: 9 },
				],
				0,
			),
		).toEqual({
			ranges: [
				{ anchor: 2, head: 5 },
				{ anchor: 9, head: 9 },
			],
			primary: 0,
		});
	});

	it("typed text does not trigger input rules per range", () => {
		const editor = createEditor("x", "x");
		caret(editor, 1);
		editor.view.dispatch(
			editor.state.tr.setMeta(multiSelectionKey, {
				ranges: [
					{ anchor: 1, head: 1 },
					{ anchor: 4, head: 4 },
				],
				primary: 0,
				wholeWord: false,
			}),
		);
		type(editor, "#");
		type(editor, " ");
		expect(editor.getJSON().content?.map((n) => n.type)).toEqual([
			"paragraph",
			"paragraph",
		]);
		expect(editor.getText()).toBe("# x\n\n# x");
	});

	it("plain-text paste inserts at every caret", async () => {
		const { handleMultiSelectionPaste } = await import(
			"./MultiSelectionExtension"
		);
		const editor = createEditor("a a");
		caret(editor, 1);
		cmdD(editor);
		cmdD(editor);
		const event = new Event("paste") as ClipboardEvent;
		Object.defineProperty(event, "clipboardData", {
			value: { getData: () => "**z**" },
		});
		expect(handleMultiSelectionPaste(editor.view, event)).toBe(true);
		expect(editor.getText()).toBe("**z** **z**");
	});
});

describe("arrows", () => {
	it("move and extend every caret", () => {
		const editor = createEditor("foo foo");
		caret(editor, 1);
		cmdD(editor);
		cmdD(editor);
		key(editor, "ArrowRight");
		expect(heads(editor)).toEqual([4, 8]);
		key(editor, "ArrowLeft");
		expect(heads(editor)).toEqual([3, 7]);
		key(editor, "ArrowLeft", { shiftKey: true });
		expect(texts(editor)).toEqual(["o", "o"]);
		key(editor, "ArrowLeft", { altKey: true });
		expect(heads(editor)).toEqual([1, 5]);
		key(editor, "ArrowRight", { metaKey: true });
		// Both carets reach the block end and merge into one.
		expect(heads(editor)).toEqual([8]);
	});

	it("Up/Down use coordsAtPos/posAtCoords per caret", () => {
		const editor = createEditor("ab ab", "zzzzz");
		caret(editor, 1);
		cmdD(editor);
		cmdD(editor);
		key(editor, "ArrowLeft");
		vi.spyOn(editor.view, "coordsAtPos").mockImplementation((pos) => ({
			left: pos * 10,
			right: pos * 10,
			top: 0,
			bottom: 10,
		}));
		vi.spyOn(editor.view, "posAtCoords").mockImplementation(({ left }) => ({
			pos: left / 10 + 7,
			inside: -1,
		}));
		key(editor, "ArrowDown");
		expect(heads(editor)).toEqual([8, 11]);
	});
});

describe("collapse and mapping", () => {
	it("Esc collapses only when extras exist", () => {
		const editor = createEditor("a a");
		caret(editor, 1);
		cmdD(editor);
		expect(key(editor, "Escape")).toBe(false);
		cmdD(editor);
		expect(key(editor, "Escape")).toBe(true);
		expect(getMultiSelectionRanges(editor.state)).toHaveLength(0);
		expect(editor.state.selection.from).toBe(3);
	});

	it("other selection changes or edits collapse; appended transactions map", () => {
		const editor = createEditor("a a a");
		caret(editor, 1);
		cmdD(editor);
		cmdD(editor);
		editor.commands.toggleBold();
		expect(getMultiSelectionRanges(editor.state)).toHaveLength(0);
		cmdD(editor);
		caret(editor, 1);
		expect(getMultiSelectionRanges(editor.state)).toHaveLength(0);
	});

	it("maps ranges through appended transactions and keeps comment anchors", () => {
		const editor = createEditor("hi hi there");
		setPendingCommentAnchor(editor, { from: 7, to: 12 });
		caret(editor, 1);
		cmdD(editor);
		cmdD(editor);
		type(editor, "hello");
		expect(pendingCommentAnchorKey.getState(editor.state)).toEqual({
			from: 13,
			to: 18,
		});
		expect(editor.state.doc.textBetween(13, 18)).toBe("there");
		const tr = editor.state.tr.insertText("X", 1);
		tr.setMeta("appendedTransaction", tr);
		editor.view.dispatch(tr);
		expect(heads(editor)).toEqual([7, 13]);
	});

	it("composition collapses instead of editing every range", () => {
		const editor = createEditor("a a");
		caret(editor, 1);
		cmdD(editor);
		cmdD(editor);
		Object.defineProperty(editor.view, "composing", {
			value: true,
			configurable: true,
		});
		expect(key(editor, "Escape")).toBe(false);
		type(editor, "x");
		expect(getMultiSelectionRanges(editor.state)).toHaveLength(0);
		expect(editor.getText()).toBe("a x");
	});
});

describe("multi-selection banner summary", () => {
	it("counts up on Cmd+D, shows the shared text, and hides on Esc", () => {
		const editor = createEditor("foo bar foo", "foo");
		caret(editor, 2);
		cmdD(editor);
		expect(multiSelectionSummary(editor.state)).toBeNull();
		cmdD(editor);
		expect(multiSelectionSummary(editor.state)).toEqual({
			count: 2,
			text: "foo",
		});
		cmdD(editor);
		const summary = multiSelectionSummary(editor.state);
		expect(summary?.count).toBe(3);
		expect(summary && multiSelectionLabel(summary)).toBe(
			"3 selections of “foo”",
		);
		expect(key(editor, "Escape")).toBe(true);
		expect(multiSelectionSummary(editor.state)).toBeNull();
	});

	it("drops the text when ranges differ", () => {
		expect(multiSelectionLabel({ count: 4, text: null })).toBe("4 selections");
	});
});
