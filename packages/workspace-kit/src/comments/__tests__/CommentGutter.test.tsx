// @vitest-environment happy-dom

import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { act, useRef } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentGutter } from "../CommentGutter";
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
		extensions: [StarterKit],
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
	onSelectThread,
}: {
	editor: Editor;
	threads: ResolvedThread[];
	onSelectThread: (threadId: string) => void;
}) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	return (
		<div ref={containerRef}>
			<CommentGutter
				editor={editor}
				containerRef={containerRef}
				threads={threads}
				onSelectThread={onSelectThread}
			/>
		</div>
	);
}

describe("CommentGutter", () => {
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

	it("renders no marker for an orphaned thread", () => {
		const editor = createEditor();
		act(() => {
			root.render(
				<Harness
					editor={editor}
					threads={[makeThread({ anchorResolution: { status: "orphaned" } })]}
					onSelectThread={vi.fn()}
				/>,
			);
		});

		expect(container.querySelectorAll("[data-comment-gutter-marker]")).toHaveLength(0);
	});

	it("renders a marker for an anchored thread and reports clicks", () => {
		const onSelectThread = vi.fn();
		const editor = createEditor();
		act(() => {
			root.render(
				<Harness
					editor={editor}
					threads={[makeThread({ state: "resolved" })]}
					onSelectThread={onSelectThread}
				/>,
			);
		});

		const markers = container.querySelectorAll<HTMLButtonElement>(
			"[data-comment-gutter-marker]",
		);
		expect(markers).toHaveLength(1);
		expect(markers[0]?.getAttribute("data-thread-id")).toBe("thread-1");
		expect(markers[0]?.getAttribute("data-resolved")).toBe("true");

		act(() => markers[0]?.click());
		expect(onSelectThread).toHaveBeenCalledWith("thread-1");
	});

	it("R17 -- two overlapping-range threads render two distinct markers, not one merged marker", () => {
		const editor = createEditor();
		act(() => {
			root.render(
				<Harness
					editor={editor}
					threads={[
						makeThread({ id: "thread-1" }),
						makeThread({ id: "thread-2" }),
					]}
					onSelectThread={vi.fn()}
				/>,
			);
		});

		const markers = container.querySelectorAll<HTMLButtonElement>(
			"[data-comment-gutter-marker]",
		);
		expect(markers).toHaveLength(2);
		expect(
			Array.from(markers).map((marker) => marker.getAttribute("data-thread-id")),
		).toEqual(["thread-1", "thread-2"]);
	});
});
