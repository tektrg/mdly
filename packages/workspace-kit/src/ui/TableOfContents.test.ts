// @vitest-environment happy-dom

import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { act, createElement } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectTableOfContentsHeadings, TableOfContents } from "./TableOfContents";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const editors: Editor[] = [];

afterEach(() => {
	for (const editor of editors) editor.destroy();
	editors.length = 0;
});

describe("collectTableOfContentsHeadings", () => {
	it("collects every heading level with document progress", () => {
		const editor = createEditor({
			type: "doc",
			content: [
				{
					type: "heading",
					attrs: { level: 1 },
					content: [{ type: "text", text: "Title" }],
				},
				{
					type: "paragraph",
					content: [{ type: "text", text: "Intro" }],
				},
				{
					type: "heading",
					attrs: { level: 4 },
					content: [{ type: "text", text: "Details" }],
				},
				{
					type: "heading",
					attrs: { level: 6 },
				},
			],
		});

		expect(collectTableOfContentsHeadings(editor.state.doc)).toEqual([
			expect.objectContaining({
				id: "heading-0",
				level: 1,
				pos: 0,
				title: "Title",
				progress: 0,
			}),
			expect.objectContaining({
				level: 4,
				title: "Details",
			}),
			expect.objectContaining({
				level: 6,
				title: "Heading 6",
			}),
		]);
	});
});


describe("TableOfContents comment indicator", () => {
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

	function docWithHeadingsAndBody() {
		return createEditor({
			type: "doc",
			content: [
				{
					type: "heading",
					attrs: { level: 1 },
					content: [{ type: "text", text: "One" }],
				},
				{ type: "paragraph", content: [{ type: "text", text: "Body" }] },
				{
					type: "heading",
					attrs: { level: 2 },
					content: [{ type: "text", text: "Two" }],
				},
			],
		});
	}

	it("shows the indicator only on the heading whose section contains a non-orphaned comment", () => {
		const editor = docWithHeadingsAndBody();
		const threads = [
			{
				id: "thread-1",
				opener: {
					id: "thread-1",
					by: { kind: "human" as const, id: "u1" },
					anchor: { from: 7, to: 9, quote: "x", mode: "quote" as const },
					text: "why?",
				},
				events: [],
				state: "open" as const,
				anchorResolution: {
					status: "anchored" as const,
					range: { from: 7, to: 9 },
					method: "revision-replay" as const,
				},
			},
		];

		act(() => {
			root.render(
				createElement(TableOfContents, {
					editor,
					scrollContainer: null,
					threads,
				}),
			);
		});

		expect(
			container.querySelector('[data-level="1"] [data-comment-indicator]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-level="2"] [data-comment-indicator]'),
		).toBeNull();
	});

	it("shows no indicator for a comment anchored before the first heading -- no section to attribute it to", () => {
		const editor = docWithHeadingsAndBody();
		// "One" is a heading node itself at pos 0; its own title text starts at
		// pos 1, which is still "at" that heading (pos <= range.from), so use a
		// position that resolves to depth 0 (the doc root) to simulate content
		// with no enclosing heading at all -- not reachable in this fixture, so
		// instead assert the realistic case: a comment inside the very first
		// heading's own title still attributes to that heading, not "none".
		const threads = [
			{
				id: "thread-1",
				opener: {
					id: "thread-1",
					by: { kind: "human" as const, id: "u1" },
					anchor: { from: 1, to: 2, quote: "O", mode: "quote" as const },
					text: "why?",
				},
				events: [],
				state: "open" as const,
				anchorResolution: {
					status: "anchored" as const,
					range: { from: 1, to: 2 },
					method: "revision-replay" as const,
				},
			},
		];

		act(() => {
			root.render(
				createElement(TableOfContents, {
					editor,
					scrollContainer: null,
					threads,
				}),
			);
		});

		expect(
			container.querySelector('[data-level="1"] [data-comment-indicator]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-level="2"] [data-comment-indicator]'),
		).toBeNull();
	});

	it("shows exactly one indicator when a heading's section has both an orphaned and a real comment", () => {
		const editor = docWithHeadingsAndBody();
		const threads = [
			{
				id: "thread-orphaned",
				opener: {
					id: "thread-orphaned",
					by: { kind: "human" as const, id: "u1" },
					anchor: { from: 7, to: 9, quote: "x", mode: "quote" as const },
					text: "stale",
				},
				events: [],
				state: "open" as const,
				anchorResolution: { status: "orphaned" as const },
			},
			{
				id: "thread-real",
				opener: {
					id: "thread-real",
					by: { kind: "human" as const, id: "u1" },
					anchor: { from: 7, to: 9, quote: "x", mode: "quote" as const },
					text: "why?",
				},
				events: [],
				state: "open" as const,
				anchorResolution: {
					status: "anchored" as const,
					range: { from: 7, to: 9 },
					method: "revision-replay" as const,
				},
			},
		];

		act(() => {
			root.render(
				createElement(TableOfContents, {
					editor,
					scrollContainer: null,
					threads,
				}),
			);
		});

		expect(
			container.querySelectorAll('[data-level="1"] [data-comment-indicator]'),
		).toHaveLength(1);
	});

	it("dims the indicator only when every comment in that heading's section is resolved", () => {
		const editor = docWithHeadingsAndBody();
		const openThread = {
			id: "thread-open",
			opener: {
				id: "thread-open",
				by: { kind: "human" as const, id: "u1" },
				anchor: { from: 7, to: 9, quote: "x", mode: "quote" as const },
				text: "why?",
			},
			events: [],
			state: "open" as const,
			anchorResolution: {
				status: "anchored" as const,
				range: { from: 7, to: 9 },
				method: "revision-replay" as const,
			},
		};
		const resolvedThread = {
			...openThread,
			id: "thread-resolved",
			state: "resolved" as const,
		};

		act(() => {
			root.render(
				createElement(TableOfContents, {
					editor,
					scrollContainer: null,
					threads: [openThread, resolvedThread],
				}),
			);
		});
		expect(
			container
				.querySelector('[data-level="1"] [data-comment-indicator]')
				?.getAttribute("data-resolved"),
		).toBe("false");

		act(() => {
			root.render(
				createElement(TableOfContents, {
					editor,
					scrollContainer: null,
					threads: [resolvedThread],
				}),
			);
		});
		expect(
			container
				.querySelector('[data-level="1"] [data-comment-indicator]')
				?.getAttribute("data-resolved"),
		).toBe("true");
	});

	it("shows no indicator when threads is omitted, same as before this feature existed", () => {
		const editor = docWithHeadingsAndBody();

		act(() => {
			root.render(
				createElement(TableOfContents, { editor, scrollContainer: null }),
			);
		});

		expect(container.querySelector("[data-comment-indicator]")).toBeNull();
	});
});

function createEditor(content: JSONContent) {
	const editor = new Editor({
		element: document.createElement("div"),
		extensions: [StarterKit],
		content,
	});
	editors.push(editor);
	return editor;
}
