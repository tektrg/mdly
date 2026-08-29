// @vitest-environment happy-dom

import { Editor, type JSONContent } from "@tiptap/core";
import { DecorationSet } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { tiptapDocToMarkdown } from "../../engine/prosemirrorToMarkdown";
import {
	buildCommentDecorations,
	CommentExtension,
	setCommentThreads,
} from "../CommentExtension";
import type { ResolvedThread } from "../useCommentThreads";

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
			content: [{ type: "text", text: "Hello world" }],
		},
	],
};

function createEditor() {
	const editor = new Editor({
		element: document.createElement("div"),
		extensions: [StarterKit, CommentExtension],
		content: DOC,
	});
	editors.push(editor);
	return editor;
}

function makeThread(overrides: Partial<ResolvedThread> = {}): ResolvedThread {
	return {
		id: "thread-1",
		opener: {
			id: "thread-1",
			by: { kind: "human", id: "u1" },
			anchor: { from: 0, to: 5, quote: "Hello", mode: "quote" },
			text: "why bold?",
		},
		events: [],
		state: "open",
		anchorResolution: {
			status: "anchored",
			range: { from: 1, to: 6 },
			method: "revision-replay",
		},
		...overrides,
	};
}

describe("CommentExtension", () => {
	it("R16 -- pushing threads never changes the serialized doc JSON or markdown", () => {
		const editor = createEditor();
		const jsonBefore = editor.getJSON();
		const markdownBefore = tiptapDocToMarkdown(jsonBefore);

		setCommentThreads(editor, [makeThread()]);

		expect(editor.getJSON()).toEqual(jsonBefore);
		expect(tiptapDocToMarkdown(editor.getJSON())).toBe(markdownBefore);
	});

	it("renders a mark for an anchored (non-orphaned) thread, resolved-styled when the thread is resolved", () => {
		const editor = createEditor();
		setCommentThreads(editor, [makeThread({ state: "resolved" })]);

		const marks = editor.view.dom.querySelectorAll(".pm-comment-mark");
		expect(marks).toHaveLength(1);
		expect(marks[0]?.classList.contains("pm-comment-mark-resolved")).toBe(true);
	});

	it("renders no mark for an orphaned thread", () => {
		const editor = createEditor();
		setCommentThreads(editor, [
			makeThread({ anchorResolution: { status: "orphaned" } }),
		]);

		expect(editor.view.dom.querySelectorAll(".pm-comment-mark")).toHaveLength(0);
	});

	it("R17 -- two fully-overlapping threads both render as independent decorations, not merged", () => {
		const editor = createEditor();
		const threads = [
			makeThread({ id: "thread-1" }),
			makeThread({
				id: "thread-2",
				opener: {
					id: "thread-2",
					by: { kind: "human", id: "u2" },
					anchor: { from: 0, to: 5, quote: "Hello", mode: "quote" },
					text: "same range, different thread",
				},
			}),
		];

		// Assert against the decoration-computation logic directly: two
		// distinct `Decoration` objects for two threads sharing a range. (DOM
		// span count is NOT the right layer to assert this at -- ProseMirror's
		// own renderer coalesces two decorations with an identical range into
		// one wrapping `<span>` for display, which is an unrelated rendering
		// optimization, not evidence either decoration was dropped. `Decoration`
		// also doesn't publicly expose the DOM attrs passed to `.inline()` --
		// only `.from`/`.to` and the internal `.spec` (a *separate*, unrelated
		// 4th constructor argument this code never sets) -- so identity here is
		// asserted via ProseMirror's own `DecorationSet`, which is the actual
		// data structure the renderer consumes.)
		const decorations = buildCommentDecorations(editor.state.doc, threads);
		expect(decorations).toHaveLength(2);
		expect(decorations.every((d) => d.from === 1 && d.to === 6)).toBe(true);

		const decorationSet = DecorationSet.create(editor.state.doc, decorations);
		expect(decorationSet.find(1, 6)).toHaveLength(2);

		// Pushing them through the real plugin must not crash or drop either
		// mark, even though ProseMirror's own DOM renderer may coalesce the two
		// into a single wrapping `<span>` for display.
		expect(() => setCommentThreads(editor, threads)).not.toThrow();
		expect(editor.view.dom.querySelectorAll(".pm-comment-mark").length).toBeGreaterThan(0);
	});
});
