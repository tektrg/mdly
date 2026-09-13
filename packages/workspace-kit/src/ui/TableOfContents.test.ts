// @vitest-environment happy-dom

import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { act, createElement } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	collectTableOfContentsHeadings,
	stabilizeHeadingIds,
	TableOfContents,
} from "./TableOfContents";

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

describe("TableOfContents scroll/resize throttling (R-hang-1b)", () => {
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

	it("coalesces a burst of scroll/resize events into a single measurement pass per frame", () => {
		const editor = createEditor({
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
		const scrollContainer = document.createElement("div");
		document.body.append(scrollContainer);

		const nodeDomSpy = vi.spyOn(editor.view, "nodeDOM");
		const rafCallbacks: FrameRequestCallback[] = [];
		const rafSpy = vi
			.spyOn(window, "requestAnimationFrame")
			.mockImplementation((callback: FrameRequestCallback) => {
				rafCallbacks.push(callback);
				return rafCallbacks.length;
			});

		act(() => {
			root.render(createElement(TableOfContents, { editor, scrollContainer }));
		});

		nodeDomSpy.mockClear();
		rafSpy.mockClear();
		rafCallbacks.length = 0;

		act(() => {
			for (let i = 0; i < 10; i++) {
				scrollContainer.dispatchEvent(new Event("scroll"));
				window.dispatchEvent(new Event("resize"));
			}
		});

		expect(rafSpy).toHaveBeenCalledTimes(1);
		expect(nodeDomSpy).not.toHaveBeenCalled();

		act(() => {
			for (const callback of rafCallbacks) callback(0);
		});

		expect(nodeDomSpy).toHaveBeenCalledTimes(2);

		rafSpy.mockClear();
		rafCallbacks.length = 0;
		act(() => {
			scrollContainer.dispatchEvent(new Event("scroll"));
		});
		expect(rafSpy).toHaveBeenCalledTimes(1);

		rafSpy.mockRestore();
		scrollContainer.remove();
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

describe("stabilizeHeadingIds (large-document editing lag)", () => {
	function heading(
		id: string,
		overrides: Partial<{ level: number; pos: number; title: string }> = {},
	) {
		return {
			id,
			level: 1,
			pos: 0,
			title: "One",
			progress: 0,
			...overrides,
		};
	}

	it("keeps identities when body edits shift positions", () => {
		const previous = [
			heading("a", { pos: 0, title: "One" }),
			heading("b", { level: 2, pos: 10, title: "Two" }),
		];
		const collected = [
			heading("heading-0", { pos: 0, title: "One" }),
			heading("heading-16", { level: 2, pos: 16, title: "Two" }),
		];

		const next = stabilizeHeadingIds(previous, collected);

		expect(next.map((entry) => entry.id)).toEqual(["a", "b"]);
		expect(next.map((entry) => entry.pos)).toEqual([0, 16]);
	});

	it("keeps a heading's identity while its title is being edited", () => {
		const previous = [
			heading("a", { pos: 0, title: "One" }),
			heading("b", { level: 2, pos: 10, title: "Two" }),
		];
		const collected = [
			heading("heading-0", { pos: 0, title: "One!" }),
			heading("heading-11", { level: 2, pos: 11, title: "Two" }),
		];

		const next = stabilizeHeadingIds(previous, collected);

		expect(next.map((entry) => entry.id)).toEqual(["a", "b"]);
		expect(next[0]?.title).toBe("One!");
	});

	it("gives an added heading a fresh id without disturbing the others", () => {
		const previous = [heading("a", { pos: 0, title: "One" })];
		const collected = [
			heading("heading-0", { pos: 0, title: "One" }),
			heading("heading-8", { level: 2, pos: 8, title: "New" }),
		];

		const next = stabilizeHeadingIds(previous, collected);

		expect(next[0]?.id).toBe("a");
		expect(next[1]?.id).not.toBe("a");
		expect(new Set(next.map((entry) => entry.id)).size).toBe(2);
	});

	it("drops a deleted heading's identity without reassigning survivors", () => {
		const previous = [
			heading("a", { pos: 0, title: "One" }),
			heading("b", { level: 2, pos: 10, title: "Two" }),
		];
		const collected = [heading("heading-0", { pos: 0, title: "One" })];

		expect(stabilizeHeadingIds(previous, collected).map((e) => e.id)).toEqual([
			"a",
		]);
	});
});

describe("TableOfContents edit-driven measurement (large-document editing lag)", () => {
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

	it("measures once on mount but coalesces edit-driven rebuilds into one frame", () => {
		const editor = createEditor({
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
		const scrollContainer = document.createElement("div");
		document.body.append(scrollContainer);

		const nodeDomSpy = vi.spyOn(editor.view, "nodeDOM");
		const rafCallbacks: FrameRequestCallback[] = [];
		const rafSpy = vi
			.spyOn(window, "requestAnimationFrame")
			.mockImplementation((callback: FrameRequestCallback) => {
				rafCallbacks.push(callback);
				return rafCallbacks.length;
			});

		try {
			act(() => {
				root.render(
					createElement(TableOfContents, { editor, scrollContainer }),
				);
			});

			expect(nodeDomSpy.mock.calls.length).toBeGreaterThan(0);
			nodeDomSpy.mockClear();
			rafCallbacks.length = 0;
			rafSpy.mockClear();

			// A body edit shifts the second heading's position and rebuilds
			// the list, but must not measure the DOM synchronously.
			act(() => {
				editor.view.dispatch(editor.state.tr.insertText("hello ", 5));
			});

			expect(nodeDomSpy).not.toHaveBeenCalled();
			expect(rafSpy).toHaveBeenCalledTimes(1);

			act(() => {
				for (const callback of rafCallbacks) callback(0);
			});

			expect(nodeDomSpy).toHaveBeenCalled();
		} finally {
			rafSpy.mockRestore();
			scrollContainer.remove();
		}
	});
});
