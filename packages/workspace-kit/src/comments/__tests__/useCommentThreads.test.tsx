// @vitest-environment happy-dom

import { Editor, type JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentOptions, CommentThread } from "../types";
import { type UseCommentThreadsResult, useCommentThreads } from "../useCommentThreads";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const editors: Editor[] = [];

afterEach(() => {
	for (const editor of editors) editor.destroy();
	editors.length = 0;
});

const identity = (text: string) => text;

function createEditor(text: string) {
	const editor = new Editor({
		element: document.createElement("div"),
		extensions: [StarterKit],
		content: {
			type: "doc",
			content: [{ type: "paragraph", content: [{ type: "text", text }] }],
		} satisfies JSONContent,
	});
	editors.push(editor);
	return editor;
}

function baseOptions(overrides: Partial<CommentOptions> = {}): CommentOptions {
	return {
		currentAuthor: { kind: "human", id: "u1" },
		docId: "doc-1",
		getHeadRevisionId: vi.fn().mockResolvedValue(null),
		getThreads: vi.fn().mockResolvedValue([]),
		readRevisionContent: vi.fn().mockResolvedValue(null),
		onOpenThread: vi.fn(),
		onReply: vi.fn(),
		onResolve: vi.fn(),
		onReopen: vi.fn(),
		...overrides,
	};
}

let latest: UseCommentThreadsResult | null = null;

function Harness({
	options,
	editor,
}: {
	options: CommentOptions | undefined;
	editor: Editor | null;
}) {
	latest = useCommentThreads(options, editor, identity);
	return null;
}

async function flush(root: ReturnType<typeof createRoot>, times = 6) {
	for (let i = 0; i < times; i++) {
		// eslint-disable-next-line no-await-in-loop
		await act(async () => {
			await Promise.resolve();
		});
	}
	void root;
}

describe("useCommentThreads", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		latest = null;
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	// R15: the opt-in gate.
	it("does nothing and fetches nothing when options is undefined", async () => {
		const editor = createEditor("Hello world");
		act(() => {
			root.render(<Harness options={undefined} editor={editor} />);
		});
		await flush(root);

		expect(latest?.resolvedThreads).toEqual([]);
		expect(latest?.error).toBeNull();
	});

	it("surfaces a getThreads rejection as `error` instead of throwing, with an empty thread list", async () => {
		const options = baseOptions({
			getThreads: vi.fn().mockRejectedValue(new Error("disk unavailable")),
		});
		const editor = createEditor("Hello world");

		expect(() => {
			act(() => {
				root.render(<Harness options={options} editor={editor} />);
			});
		}).not.toThrow();
		await flush(root);

		expect(latest?.resolvedThreads).toEqual([]);
		expect(latest?.error).toBe("disk unavailable");
	});

	// Live-edit re-resolution: an edit above the anchor shifts the quote's
	// position in the live draft, and the hook must re-resolve on the
	// editor's own "update" event -- no getThreads re-fetch required.
	it("re-resolves against live editor edits without needing a threads re-fetch", async () => {
		const thread: CommentThread = {
			id: "thread-1",
			opener: {
				id: "thread-1",
				by: { kind: "human", id: "u1" },
				anchor: { from: 0, to: 5, quote: "TARGET", mode: "quote" },
				text: "why?",
			},
			events: [],
			state: "open",
		};
		const options = baseOptions({ getThreads: vi.fn().mockResolvedValue([thread]) });
		const editor = createEditor("TARGET rest of the line");

		act(() => {
			root.render(<Harness options={options} editor={editor} />);
		});
		await flush(root);

		expect(latest?.resolvedThreads).toHaveLength(1);
		const firstRange = latest?.resolvedThreads[0]?.anchorResolution.range;
		expect(firstRange).toEqual({ from: 0, to: 6 });

		// Insert text before the anchored quote -- the quote's offset in the
		// flattened text must move forward, purely from the editor's own
		// "update" event, with getThreads never called again.
		act(() => {
			editor.view.dispatch(
				editor.state.tr
					.setSelection(TextSelection.create(editor.state.doc, 1))
					.insertText("PREFIX "),
			);
		});
		await flush(root);

		const movedRange = latest?.resolvedThreads[0]?.anchorResolution.range;
		expect(movedRange).toEqual({ from: 7, to: 13 });
		expect(options.getThreads).toHaveBeenCalledTimes(1);
	});

	// External-file-reload re-resolution: EditorView applies a reloaded file
	// via `setContent(doc, { emitUpdate: false })`, which suppresses the
	// editor's "update" event by design. The hook must still re-resolve
	// anchors off the "transaction" that setContent still dispatches, or
	// highlights go stale against the file's old text.
	it("re-resolves after an external reload applied with emitUpdate: false", async () => {
		const thread: CommentThread = {
			id: "thread-1",
			opener: {
				id: "thread-1",
				by: { kind: "human", id: "u1" },
				anchor: { from: 0, to: 5, quote: "TARGET", mode: "quote" },
				text: "why?",
			},
			events: [],
			state: "open",
		};
		const options = baseOptions({ getThreads: vi.fn().mockResolvedValue([thread]) });
		const editor = createEditor("TARGET rest of the line");

		act(() => {
			root.render(<Harness options={options} editor={editor} />);
		});
		await flush(root);

		expect(latest?.resolvedThreads[0]?.anchorResolution.range).toEqual({
			from: 0,
			to: 6,
		});

		act(() => {
			editor.commands.setContent(
				{
					type: "doc",
					content: [
						{
							type: "paragraph",
							content: [{ type: "text", text: "PREFIX TARGET rest of the line" }],
						},
					],
				} satisfies JSONContent,
				{ emitUpdate: false },
			);
		});
		await flush(root);

		expect(latest?.resolvedThreads[0]?.anchorResolution.range).toEqual({
			from: 7,
			to: 13,
		});
	});

	it("keeps the same resolvedThreads reference across a transaction that cannot affect any anchor", async () => {
		const thread: CommentThread = {
			id: "thread-1",
			opener: {
				id: "thread-1",
				by: { kind: "human", id: "u1" },
				anchor: { from: 0, to: 5, quote: "TARGET", mode: "quote" },
				text: "why?",
			},
			events: [],
			state: "open",
		};
		const options = baseOptions({ getThreads: vi.fn().mockResolvedValue([thread]) });
		const editor = createEditor("TARGET rest of the line");

		act(() => {
			root.render(<Harness options={options} editor={editor} />);
		});
		await flush(root);

		const beforeThreads = latest?.resolvedThreads;

		act(() => {
			editor.view.dispatch(
				editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)),
			);
		});
		await flush(root);

		expect(latest?.resolvedThreads).toBe(beforeThreads);
	});

	// The store behind a real `getThreads` (`@mdly/doc-comments`) documents its
	// own `events` field as "thread-opened first, then replies/resolves/
	// reopens" -- i.e. it includes the opener. This kit's `CommentThread.events`
	// is documented the opposite way: "every event AFTER the opener". A host
	// passing the store's raw shape straight through must not leak the opener
	// into `events`, or every consumer (ThreadPanel, the paragraph/gutter
	// markers) renders the opener's text twice.
	it("strips the opener event out of `events` when a host's getThreads includes it there too", async () => {
		const thread: CommentThread = {
			id: "thread-1",
			opener: {
				id: "event-open",
				by: { kind: "human", id: "u1" },
				anchor: { from: 0, to: 5, quote: "TARGET", mode: "quote" },
				text: "why?",
			},
			events: [
				{
					id: "event-open",
					kind: "thread-opened",
					by: { kind: "human", id: "u1" },
					text: "why?",
					prev: null,
				},
				{
					id: "event-reply",
					kind: "replied",
					by: { kind: "human", id: "u2" },
					text: "because",
					prev: "event-open",
				},
			],
			state: "open",
		};
		const options = baseOptions({ getThreads: vi.fn().mockResolvedValue([thread]) });
		const editor = createEditor("TARGET rest of the line");

		act(() => {
			root.render(<Harness options={options} editor={editor} />);
		});
		await flush(root);

		const events = latest?.resolvedThreads[0]?.events;
		expect(events).toHaveLength(1);
		expect(events?.[0]?.id).toBe("event-reply");
	});

	it("still produces a new resolvedThreads reference when a thread's state changes with its anchor unchanged", async () => {
		const openThread: CommentThread = {
			id: "thread-1",
			opener: {
				id: "thread-1",
				by: { kind: "human", id: "u1" },
				anchor: { from: 0, to: 5, quote: "TARGET", mode: "quote" },
				text: "why?",
			},
			events: [],
			state: "open",
		};
		const getThreads = vi.fn().mockResolvedValue([openThread]);
		const options = baseOptions({ getThreads });
		const editor = createEditor("TARGET rest of the line");

		act(() => {
			root.render(<Harness options={options} editor={editor} />);
		});
		await flush(root);

		const beforeThreads = latest?.resolvedThreads;
		expect(beforeThreads?.[0]?.state).toBe("open");

		const resolvedThread: CommentThread = {
			...openThread,
			state: "resolved",
			events: [{ id: "event-1", kind: "resolved", by: { kind: "human", id: "u1" }, prev: null }],
		};
		getThreads.mockResolvedValue([resolvedThread]);

		act(() => {
			latest?.refetch();
		});
		await flush(root);

		expect(latest?.resolvedThreads).not.toBe(beforeThreads);
		expect(latest?.resolvedThreads[0]?.state).toBe("resolved");
	});
});
