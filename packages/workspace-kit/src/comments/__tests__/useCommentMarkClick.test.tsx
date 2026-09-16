// @vitest-environment happy-dom

import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentExtension, setCommentThreads } from "../CommentExtension";
import { useCommentMarkClick } from "../useCommentMarkClick";
import type { ResolvedThread } from "../useCommentThreads";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

function Harness({
	editor,
	onSelectThread,
}: {
	editor: Editor;
	onSelectThread: (threadId: string) => void;
}) {
	useCommentMarkClick(editor, onSelectThread);
	return null;
}

describe("useCommentMarkClick", () => {
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

	it("selects the clicked mark's thread", () => {
		const editor = createEditor();
		const onSelectThread = vi.fn();
		setCommentThreads(editor, [makeThread()]);
		act(() => {
			root.render(<Harness editor={editor} onSelectThread={onSelectThread} />);
		});

		const mark = editor.view.dom.querySelector<HTMLElement>(".pm-comment-mark");
		expect(mark).not.toBeNull();
		act(() => {
			mark?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(onSelectThread).toHaveBeenCalledWith("thread-1");
	});

	// A drag that starts or ends on an existing mark leaves a non-empty
	// selection at mouseup -- CommentComposer's own "new comment" trigger
	// already handles that gesture, so a mark click must stay out of the way
	// rather than also focusing a thread on top of it.
	it("does not select when the click's mouseup left a non-empty selection (a drag, not a plain click)", () => {
		const editor = createEditor();
		const onSelectThread = vi.fn();
		setCommentThreads(editor, [makeThread()]);
		act(() => {
			root.render(<Harness editor={editor} onSelectThread={onSelectThread} />);
		});

		act(() => {
			editor.commands.setTextSelection({ from: 1, to: 6 });
		});
		const mark = editor.view.dom.querySelector<HTMLElement>(".pm-comment-mark");
		act(() => {
			mark?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(onSelectThread).not.toHaveBeenCalled();
	});

	it("selects the correct thread when multiple marks are present", () => {
		const editor = createEditor();
		const onSelectThread = vi.fn();
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
		setCommentThreads(editor, [threadA, threadB]);
		act(() => {
			root.render(<Harness editor={editor} onSelectThread={onSelectThread} />);
		});

		const marks =
			editor.view.dom.querySelectorAll<HTMLElement>(".pm-comment-mark");
		expect(marks).toHaveLength(2);

		act(() => {
			marks[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(onSelectThread).toHaveBeenLastCalledWith("thread-a");

		act(() => {
			marks[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(onSelectThread).toHaveBeenLastCalledWith("thread-b");
	});

	it("ignores clicks that don't land on a comment mark", () => {
		const editor = createEditor();
		const onSelectThread = vi.fn();
		setCommentThreads(editor, [makeThread()]);
		act(() => {
			root.render(<Harness editor={editor} onSelectThread={onSelectThread} />);
		});

		editor.view.dom.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(onSelectThread).not.toHaveBeenCalled();
	});
});
