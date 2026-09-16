// @vitest-environment happy-dom

import { Editor, type JSONContent } from "@tiptap/core";
import { DecorationSet } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { tiptapDocToMarkdown } from "../../engine/prosemirrorToMarkdown";
import {
	buildCommentDecorations,
	CommentExtension,
	pendingCommentAnchorKey,
	setCommentThreads,
	setPendingCommentAnchor,
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

		expect(editor.view.dom.querySelectorAll(".pm-comment-mark")).toHaveLength(
			0,
		);
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
		expect(
			editor.view.dom.querySelectorAll(".pm-comment-mark").length,
		).toBeGreaterThan(0);
	});

	// Regression for the 2026-09-02 renderer-storm crash (crash-trace.log:
	// ~766K `editor.transaction` dispatches over one 23-minute idle session,
	// every one carrying only `commentThreadsKey`'s meta, steps:0,
	// docChanged:false). `useCommentThreads`'s `editor.on("transaction", ...)`
	// listener re-runs on every dispatch including `setCommentThreads`'s own,
	// so if `setCommentThreads` dispatches unconditionally, ANY caller that
	// ever passes a content-identical-but-freshly-allocated `ResolvedThread[]`
	// (e.g. a refetch racing a no-op) re-ignites that listener with no upper
	// bound. Before the ignition guard, this test's second call dispatched a
	// second transaction and failed.
	it("does not dispatch a second transaction when called again with content-identical (but freshly-allocated) threads", () => {
		const editor = createEditor();
		const first = [makeThread()];
		// A structurally-identical but reference-distinct array/objects -- the
		// shape a refetch or a re-render produces even when nothing changed.
		const second = [makeThread()];
		expect(first).not.toBe(second);
		expect(first[0]).not.toBe(second[0]);

		let dispatchCount = 0;
		const originalDispatch = editor.view.dispatch.bind(editor.view);
		editor.view.dispatch = (tr) => {
			dispatchCount++;
			return originalDispatch(tr);
		};

		setCommentThreads(editor, first);
		expect(dispatchCount).toBe(1);

		setCommentThreads(editor, second);
		expect(dispatchCount).toBe(1);

		// A genuinely different list must still get through.
		setCommentThreads(editor, [makeThread({ state: "resolved" })]);
		expect(dispatchCount).toBe(2);
	});

	it("adds pm-comment-mark-focused only to the thread matching focusedThreadId", () => {
		const editor = createEditor();
		const threadA = makeThread({
			id: "thread-a",
			opener: { ...makeThread().opener, id: "thread-a" },
			anchorResolution: { status: "anchored", range: { from: 1, to: 6 } },
		});
		const threadB = makeThread({
			id: "thread-b",
			opener: {
				...makeThread().opener,
				id: "thread-b",
				anchor: { from: 6, to: 11, quote: "world", mode: "quote" },
			},
			anchorResolution: { status: "anchored", range: { from: 7, to: 12 } },
		});
		setCommentThreads(editor, [threadA, threadB], "thread-b");

		const marks =
			editor.view.dom.querySelectorAll<HTMLElement>(".pm-comment-mark");
		expect(marks).toHaveLength(2);
		const focused = Array.from(marks).filter((mark) =>
			mark.classList.contains("pm-comment-mark-focused"),
		);
		expect(focused).toHaveLength(1);
		expect(focused[0]?.getAttribute("data-thread-id")).toBe("thread-b");
	});

	// Regression guard mirroring the ignition-guard test above, but for a
	// focus change alone: re-focusing a *different* thread id with the exact
	// same threads array must dispatch exactly once for that change, and
	// calling it again with an identical combined {threads, focusedThreadId}
	// must not dispatch at all -- otherwise a host effect keyed on
	// `focusedThreadId` changing (see EditorView.tsx) could re-ignite
	// `useCommentThreads`'s "transaction" listener the same way an unstable
	// thread list could (see the OOM writeup this file already references).
	it("does not dispatch a second transaction when focusedThreadId is set again unchanged, but does dispatch on a real focus change", () => {
		const editor = createEditor();
		const threads = [makeThread()];

		let dispatchCount = 0;
		const originalDispatch = editor.view.dispatch.bind(editor.view);
		editor.view.dispatch = (tr) => {
			dispatchCount++;
			return originalDispatch(tr);
		};

		setCommentThreads(editor, threads, "thread-1");
		expect(dispatchCount).toBe(1);

		// Same threads reference, same focus id -- no-op.
		setCommentThreads(editor, threads, "thread-1");
		expect(dispatchCount).toBe(1);

		// Same threads reference, focus id actually changes -- must dispatch.
		setCommentThreads(editor, threads, null);
		expect(dispatchCount).toBe(2);
	});
});

describe("pendingCommentAnchorKey / setPendingCommentAnchor", () => {
	it("renders a pm-comment-mark-pending decoration over the given range", () => {
		const editor = createEditor();
		setPendingCommentAnchor(editor, { from: 1, to: 6 });

		const mark = editor.view.dom.querySelector(".pm-comment-mark-pending");
		expect(mark).not.toBeNull();
		expect(mark?.textContent).toBe("Hello");
	});

	it("clears the decoration when set back to null", () => {
		const editor = createEditor();
		setPendingCommentAnchor(editor, { from: 1, to: 6 });
		expect(
			editor.view.dom.querySelector(".pm-comment-mark-pending"),
		).not.toBeNull();

		setPendingCommentAnchor(editor, null);
		expect(
			editor.view.dom.querySelector(".pm-comment-mark-pending"),
		).toBeNull();
	});

	it("never touches document content, mirroring R16 for comment-thread decorations", () => {
		const editor = createEditor();
		const jsonBefore = editor.getJSON();

		setPendingCommentAnchor(editor, { from: 1, to: 6 });

		expect(editor.getJSON()).toEqual(jsonBefore);
	});

	// Regression: the panel is non-modal, so the user can keep typing
	// elsewhere in the document while a new-comment draft is open. Before this
	// fix, the plugin's `apply` carried the raw `{from, to}` forward unchanged
	// across every later transaction, so it drifted out of sync with the doc
	// as soon as anything before the anchor changed length.
	it("remaps the pending range through a doc-changing transaction elsewhere in the document", () => {
		const editor = createEditor();
		// DOC is "Hello world"; anchor "world" at [7, 12].
		setPendingCommentAnchor(editor, { from: 7, to: 12 });

		// Insert text at the very start of the doc -- well before the anchor.
		editor.view.dispatch(editor.state.tr.insertText("Say ", 1));

		expect(pendingCommentAnchorKey.getState(editor.state)).toEqual({
			from: 11,
			to: 16,
		});
		const mark = editor.view.dom.querySelector(".pm-comment-mark-pending");
		expect(mark?.textContent).toBe("world");
	});

	// Regression: deleting the exact anchored text used to leave a
	// zero/negative-width range in plugin state, which `Decoration.inline`
	// throws on the next time decorations are computed.
	it("clears the pending anchor instead of throwing when the anchored text itself is deleted", () => {
		const editor = createEditor();
		setPendingCommentAnchor(editor, { from: 7, to: 12 });

		expect(() => {
			editor.view.dispatch(editor.state.tr.delete(7, 12));
		}).not.toThrow();

		expect(pendingCommentAnchorKey.getState(editor.state)).toBeNull();
		expect(
			editor.view.dom.querySelector(".pm-comment-mark-pending"),
		).toBeNull();
	});

	// Defensive clamp mirroring `buildCommentDecorations`'s own: even if a
	// stale/out-of-bounds range ever reaches plugin state directly (bypassing
	// the `apply` remap above), computing decorations must degrade to no
	// highlight rather than crash the view.
	it("never throws building decorations for an out-of-bounds range", () => {
		const editor = createEditor();
		const docSize = editor.state.doc.content.size;

		// `Decoration.inline` throws immediately when the view recomputes
		// decorations during `dispatch` if the range is out of bounds, so the
		// assertion has to wrap the call that triggers that recomputation.
		expect(() => {
			setPendingCommentAnchor(editor, { from: 1, to: docSize + 50 });
		}).not.toThrow();
		expect(
			editor.view.dom.querySelector(".pm-comment-mark-pending"),
		).toBeNull();
	});

	// Same ignition-guard shape as `setCommentThreads` -- a caller that passes
	// a content-identical-but-freshly-allocated range object must not
	// dispatch a redundant transaction.
	it("does not dispatch a second transaction for a content-identical (but freshly-allocated) range", () => {
		const editor = createEditor();
		let dispatchCount = 0;
		const originalDispatch = editor.view.dispatch.bind(editor.view);
		editor.view.dispatch = (tr) => {
			dispatchCount++;
			return originalDispatch(tr);
		};

		setPendingCommentAnchor(editor, { from: 1, to: 6 });
		expect(dispatchCount).toBe(1);

		setPendingCommentAnchor(editor, { from: 1, to: 6 });
		expect(dispatchCount).toBe(1);

		setPendingCommentAnchor(editor, { from: 2, to: 6 });
		expect(dispatchCount).toBe(2);

		expect(pendingCommentAnchorKey.getState(editor.state)).toEqual({
			from: 2,
			to: 6,
		});
	});
});
