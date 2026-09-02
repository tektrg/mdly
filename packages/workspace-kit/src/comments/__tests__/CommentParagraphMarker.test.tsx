// @vitest-environment happy-dom

import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { act, useRef } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentParagraphMarker } from "../CommentParagraphMarker";
import type { ResolvedThread } from "../useCommentThreads";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const editors: Editor[] = [];

afterEach(() => {
	for (const editor of editors) editor.destroy();
	editors.length = 0;
});

// Paragraph 1 ("Hello world") occupies doc positions 0-12; paragraph 2
// ("Second paragraph text") starts at position 13. Exact character
// boundaries within each paragraph don't matter here -- this component only
// resolves `range.from` to its enclosing textblock, it never reads `quote`.
const DOC: JSONContent = {
	type: "doc",
	content: [
		{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] },
		{
			type: "paragraph",
			content: [{ type: "text", text: "Second paragraph text" }],
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

function makeThread(
	id: string,
	range: { from: number; to: number },
	overrides: Partial<ResolvedThread> = {},
): ResolvedThread {
	return {
		id,
		opener: {
			id,
			by: { kind: "human", id: "u1" },
			anchor: { from: range.from, to: range.to, quote: "x", mode: "quote" },
			text: "why?",
		},
		events: [],
		state: "open",
		anchorResolution: { status: "anchored", range, method: "revision-replay" },
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
			<CommentParagraphMarker
				editor={editor}
				containerRef={containerRef}
				threads={threads}
				onSelectThread={onSelectThread}
			/>
		</div>
	);
}

describe("CommentParagraphMarker", () => {
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

	it("renders no marker when every thread is orphaned", () => {
		const editor = createEditor();
		act(() => {
			root.render(
				<Harness
					editor={editor}
					threads={[
						makeThread(
							"thread-1",
							{ from: 1, to: 6 },
							{ anchorResolution: { status: "orphaned" } },
						),
					]}
					onSelectThread={vi.fn()}
				/>,
			);
		});

		expect(
			container.querySelectorAll("[data-comment-paragraph-marker]"),
		).toHaveLength(0);
	});

	it("collapses two threads anchored in the same paragraph into one marker with a count badge, and jumps to the first on click", () => {
		const onSelectThread = vi.fn();
		const editor = createEditor();
		act(() => {
			root.render(
				<Harness
					editor={editor}
					threads={[
						makeThread("thread-1", { from: 1, to: 6 }),
						makeThread("thread-2", { from: 8, to: 12 }),
					]}
					onSelectThread={onSelectThread}
				/>,
			);
		});

		const markers = container.querySelectorAll<HTMLButtonElement>(
			"[data-comment-paragraph-marker]",
		);
		expect(markers).toHaveLength(1);
		expect(markers[0]?.getAttribute("data-thread-id")).toBe("thread-1");
		expect(markers[0]?.querySelector("[data-comment-count]")?.textContent).toBe(
			"2",
		);

		act(() => markers[0]?.click());
		expect(onSelectThread).toHaveBeenCalledWith("thread-1");
	});

	it("renders a separate marker per paragraph, with no count badge when a paragraph has exactly one thread", () => {
		const editor = createEditor();
		act(() => {
			root.render(
				<Harness
					editor={editor}
					threads={[
						makeThread("thread-1", { from: 1, to: 6 }),
						makeThread("thread-2", { from: 15, to: 20 }),
					]}
					onSelectThread={vi.fn()}
				/>,
			);
		});

		const markers = container.querySelectorAll<HTMLButtonElement>(
			"[data-comment-paragraph-marker]",
		);
		expect(markers).toHaveLength(2);
		expect(
			Array.from(markers).map((marker) => marker.getAttribute("data-thread-id")),
		).toEqual(["thread-1", "thread-2"]);
		for (const marker of markers) {
			expect(marker.querySelector("[data-comment-count]")).toBeNull();
		}
	});
});
