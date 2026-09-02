// @vitest-environment happy-dom

import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { act, useRef } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentExtension, setCommentThreads } from "../CommentExtension";
import { CommentThreadPopover } from "../CommentThreadPopover";
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
	threads,
	onReply = () => Promise.resolve(),
	onResolve = () => Promise.resolve(),
	onReopen = () => Promise.resolve(),
}: {
	editor: Editor;
	threads: ResolvedThread[];
	onReply?: (threadId: string, text: string) => Promise<void>;
	onResolve?: (threadId: string) => Promise<void>;
	onReopen?: (threadId: string) => Promise<void>;
}) {
	const viewportRef = useRef<HTMLDivElement | null>(null);
	return (
		<div ref={viewportRef}>
			<CommentThreadPopover
				editor={editor}
				viewportRef={viewportRef}
				threads={threads}
				onReply={onReply}
				onResolve={onResolve}
				onReopen={onReopen}
			/>
		</div>
	);
}

describe("CommentThreadPopover", () => {
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

	it("renders nothing until a comment mark is clicked", () => {
		const editor = createEditor();
		setCommentThreads(editor, [makeThread()]);
		act(() => {
			root.render(<Harness editor={editor} threads={[makeThread()]} />);
		});

		expect(container.querySelector("[data-comment-thread-popover]")).toBeNull();
	});

	it("shows the clicked thread's content, reusing ThreadItem's own markup", () => {
		const editor = createEditor();
		const thread = makeThread({ opener: { ...makeThread().opener, text: "why bold?" } });
		setCommentThreads(editor, [thread]);
		act(() => {
			root.render(<Harness editor={editor} threads={[thread]} />);
		});

		const mark = editor.view.dom.querySelector<HTMLElement>(".pm-comment-mark");
		expect(mark).not.toBeNull();
		act(() => {
			mark?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		const popover = container.querySelector("[data-comment-thread-popover]");
		expect(popover).not.toBeNull();
		expect(popover?.querySelector("[data-comment-thread]")?.getAttribute("data-thread-id")).toBe(
			"thread-1",
		);
		expect(popover?.textContent).toContain("why bold?");
	});

	// A drag that starts or ends on an existing mark leaves a non-empty
	// selection at mouseup -- CommentComposer's own "new comment" trigger
	// already handles that gesture, so this popover must stay out of the way
	// rather than opening on top of it.
	it("does not open when the click's mouseup left a non-empty selection (a drag, not a plain click)", () => {
		const editor = createEditor();
		const thread = makeThread();
		setCommentThreads(editor, [thread]);
		act(() => {
			root.render(<Harness editor={editor} threads={[thread]} />);
		});

		act(() => {
			editor.commands.setTextSelection({ from: 1, to: 6 });
		});
		const mark = editor.view.dom.querySelector<HTMLElement>(".pm-comment-mark");
		act(() => {
			mark?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(container.querySelector("[data-comment-thread-popover]")).toBeNull();
	});

	it("switches to a different thread when its own mark is clicked next", () => {
		const editor = createEditor();
		const threadA = makeThread({
			id: "thread-a",
			opener: { ...makeThread().opener, id: "thread-a", text: "comment A" },
			anchorResolution: { status: "anchored", range: { from: 1, to: 6 } },
		});
		const threadB = makeThread({
			id: "thread-b",
			opener: {
				...makeThread().opener,
				id: "thread-b",
				anchor: { from: 6, to: 11, quote: "world", mode: "quote" },
				text: "comment B",
			},
			anchorResolution: { status: "anchored", range: { from: 7, to: 12 } },
		});
		setCommentThreads(editor, [threadA, threadB]);
		act(() => {
			root.render(<Harness editor={editor} threads={[threadA, threadB]} />);
		});

		const marks = editor.view.dom.querySelectorAll<HTMLElement>(".pm-comment-mark");
		expect(marks).toHaveLength(2);

		act(() => {
			marks[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(
			container.querySelector("[data-comment-thread]")?.getAttribute("data-thread-id"),
		).toBe("thread-a");

		act(() => {
			marks[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(
			container.querySelector("[data-comment-thread]")?.getAttribute("data-thread-id"),
		).toBe("thread-b");
	});

	it("closes when a click lands outside both the editor and the popover", () => {
		const editor = createEditor();
		const thread = makeThread();
		setCommentThreads(editor, [thread]);
		// Appended as a sibling of `container`, not inside it -- `container` is
		// exclusively React's own root, and a node appended inside it would be
		// removed the next time React re-renders (e.g. the state update from
		// the click below).
		const outside = document.createElement("button");
		document.body.append(outside);
		act(() => {
			root.render(<Harness editor={editor} threads={[thread]} />);
		});

		const mark = editor.view.dom.querySelector<HTMLElement>(".pm-comment-mark");
		act(() => {
			mark?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(container.querySelector("[data-comment-thread-popover]")).not.toBeNull();

		act(() => {
			outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		});
		expect(container.querySelector("[data-comment-thread-popover]")).toBeNull();
		outside.remove();
	});

	it("closes on Escape", () => {
		const editor = createEditor();
		const thread = makeThread();
		setCommentThreads(editor, [thread]);
		act(() => {
			root.render(<Harness editor={editor} threads={[thread]} />);
		});

		const mark = editor.view.dom.querySelector<HTMLElement>(".pm-comment-mark");
		act(() => {
			mark?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(container.querySelector("[data-comment-thread-popover]")).not.toBeNull();

		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});
		expect(container.querySelector("[data-comment-thread-popover]")).toBeNull();
	});

	it("closes itself when the open thread disappears from `threads` (e.g. resolved via the side panel)", () => {
		const editor = createEditor();
		const thread = makeThread();
		setCommentThreads(editor, [thread]);
		act(() => {
			root.render(<Harness editor={editor} threads={[thread]} />);
		});

		const mark = editor.view.dom.querySelector<HTMLElement>(".pm-comment-mark");
		act(() => {
			mark?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(container.querySelector("[data-comment-thread-popover]")).not.toBeNull();

		act(() => {
			root.render(<Harness editor={editor} threads={[]} />);
		});
		expect(container.querySelector("[data-comment-thread-popover]")).toBeNull();
	});

	it("forwards a reply through to onReply for the popover's own thread", async () => {
		const onReply = vi.fn().mockResolvedValue(undefined);
		const editor = createEditor();
		const thread = makeThread();
		setCommentThreads(editor, [thread]);
		act(() => {
			root.render(<Harness editor={editor} threads={[thread]} onReply={onReply} />);
		});

		const mark = editor.view.dom.querySelector<HTMLElement>(".pm-comment-mark");
		act(() => {
			mark?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		const textarea = container.querySelector<HTMLTextAreaElement>("[data-reply-textarea]");
		const nativeValueSetter = Object.getOwnPropertyDescriptor(
			window.HTMLTextAreaElement.prototype,
			"value",
		)?.set;
		act(() => {
			nativeValueSetter?.call(textarea, "because");
			textarea?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			container.querySelector<HTMLButtonElement>("[data-reply-button]")?.click();
		});

		expect(onReply).toHaveBeenCalledWith("thread-1", "because");
	});
});
