// @vitest-environment happy-dom

import { Editor, type JSONContent } from "@tiptap/core";
import { PluginKey, TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildQuoteAnchor } from "../buildAnchor";
import type { CommentOptions, CommentThread } from "../types";
import {
	type UseCommentThreadsResult,
	useCommentThreads,
} from "../useCommentThreads";

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
		onDelete: vi.fn(),
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
		const options = baseOptions({
			getThreads: vi.fn().mockResolvedValue([thread]),
		});
		const editor = createEditor("TARGET rest of the line");

		act(() => {
			root.render(<Harness options={options} editor={editor} />);
		});
		await flush(root);

		expect(latest?.resolvedThreads).toHaveLength(1);
		const firstRange = latest?.resolvedThreads[0]?.anchorResolution.range;
		expect(firstRange).toEqual({ from: 1, to: 7 });

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
		expect(movedRange).toEqual({ from: 8, to: 14 });
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
		const options = baseOptions({
			getThreads: vi.fn().mockResolvedValue([thread]),
		});
		const editor = createEditor("TARGET rest of the line");

		act(() => {
			root.render(<Harness options={options} editor={editor} />);
		});
		await flush(root);

		expect(latest?.resolvedThreads[0]?.anchorResolution.range).toEqual({
			from: 1,
			to: 7,
		});

		act(() => {
			editor.commands.setContent(
				{
					type: "doc",
					content: [
						{
							type: "paragraph",
							content: [
								{ type: "text", text: "PREFIX TARGET rest of the line" },
							],
						},
					],
				} satisfies JSONContent,
				{ emitUpdate: false },
			);
		});
		await flush(root);

		expect(latest?.resolvedThreads[0]?.anchorResolution.range).toEqual({
			from: 8,
			to: 14,
		});
	});

	// Anchor-position regression: a comment pinned on one paragraph of a
	// multi-paragraph doc must resolve onto that same paragraph -- never a
	// later one. `resolveAnchor` returns flattened-markdown offsets (which
	// count markup like `# ` and double-newline joins that have no document
	// position); the hook translates the quote back onto live ProseMirror
	// positions before publishing `anchorResolution.range`, which is what
	// every consumer (decorations, gutter, paragraph markers, TOC) reads.
	it("pins a comment on its own paragraph in a multi-paragraph doc with markup above", async () => {
		const editor = new Editor({
			element: document.createElement("div"),
			extensions: [StarterKit],
			content: {
				type: "doc",
				content: [
					{
						type: "heading",
						attrs: { level: 1 },
						content: [{ type: "text", text: "Title here" }],
					},
					{
						type: "paragraph",
						content: [{ type: "text", text: "First paragraph here" }],
					},
					{
						type: "paragraph",
						content: [{ type: "text", text: "Second paragraph TARGET text" }],
					},
					{
						type: "paragraph",
						content: [{ type: "text", text: "Third paragraph here" }],
					},
				],
			} satisfies JSONContent,
		});
		editors.push(editor);

		const quote = "TARGET";
		let pmFrom = -1;
		for (let p = 0; p < editor.state.doc.content.size; p++) {
			try {
				if (editor.state.doc.textBetween(p, p + quote.length, "\n") === quote) {
					pmFrom = p;
					break;
				}
			} catch {
				// Past the end of the document -- keep scanning harmlessly.
			}
		}
		expect(pmFrom).toBeGreaterThan(-1);
		const anchor = buildQuoteAnchor(
			editor.state.doc,
			pmFrom,
			pmFrom + quote.length,
		);
		expect(anchor.quote).toBe(quote);

		const thread: CommentThread = {
			id: "thread-1",
			opener: {
				id: "thread-1",
				by: { kind: "human", id: "u1" },
				anchor,
				text: "why?",
			},
			events: [],
			state: "open",
		};
		const options = baseOptions({
			getThreads: vi.fn().mockResolvedValue([thread]),
		});

		act(() => {
			root.render(<Harness options={options} editor={editor} />);
		});
		await flush(root);

		const resolution = latest?.resolvedThreads[0]?.anchorResolution;
		expect(resolution?.status).toBe("fallback-anchored");
		expect(resolution?.range).toEqual({
			from: pmFrom,
			to: pmFrom + quote.length,
		});
		expect(
			editor.state.doc.textBetween(
				resolution?.range?.from ?? 0,
				resolution?.range?.to ?? 0,
				"\n",
			),
		).toBe(quote);
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
		const options = baseOptions({
			getThreads: vi.fn().mockResolvedValue([thread]),
		});
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

	// Regression for the 2026-09-02 renderer-storm crash (crash-trace.log:
	// ~766K `editor.transaction` dispatches over one 23-minute idle session,
	// every one carrying only `commentThreadsKey`'s meta, steps:0,
	// docChanged:false, editorFocused:false). The "transaction" listener used
	// to call `resolveAnchor` (and thus `readRevisionContent`) again for EVERY
	// transaction, including a meta-only one carrying no doc change -- e.g.
	// `setCommentThreads`'s own dispatch, echoed straight back into this same
	// listener. `resolvedThreads`'s own content-equality guard (tested above)
	// stops that particular cycle from free-running once inputs are stable,
	// but it still means every meta-only echo redoes a full anchor-resolution
	// pass (an `await readRevisionContent(...)` per thread) for nothing.
	// Gating on `docChanged` means a transaction that cannot possibly move any
	// anchor (`resolveAnchor` only ever reads document content, never
	// selection or plugin meta) does no resolution work at all -- verified
	// directly here via `readRevisionContent`'s call count, since the
	// downstream reference-stability test can't distinguish "did no work" from
	// "did the work again and got the same answer".
	it("does not call readRevisionContent again for a meta-only transaction that cannot affect any anchor", async () => {
		const thread: CommentThread = {
			id: "thread-1",
			opener: {
				id: "thread-1",
				by: { kind: "human", id: "u1" },
				anchor: {
					from: 0,
					to: 5,
					quote: "TARGET",
					mode: "revision",
					revisionId: "rev-1",
				},
				text: "why?",
			},
			events: [],
			state: "open",
		};
		const readRevisionContent = vi
			.fn()
			.mockResolvedValue("TARGET rest of the line");
		const options = baseOptions({
			getThreads: vi.fn().mockResolvedValue([thread]),
			readRevisionContent,
		});
		const editor = createEditor("TARGET rest of the line");

		act(() => {
			root.render(<Harness options={options} editor={editor} />);
		});
		await flush(root);

		expect(latest?.resolvedThreads).toHaveLength(1);
		const callsAfterInitialResolve = readRevisionContent.mock.calls.length;
		expect(callsAfterInitialResolve).toBeGreaterThan(0);

		// setCommentThreads's own dispatch shape: meta-only, no doc/selection
		// change -- dispatched several times, matching the sustained-storm shape
		// rather than a single occurrence.
		const dummyKey = new PluginKey<number>("regressionDummy");
		act(() => {
			for (let i = 0; i < 5; i++) {
				editor.view.dispatch(editor.state.tr.setMeta(dummyKey, i));
			}
		});
		await flush(root);

		expect(readRevisionContent.mock.calls.length).toBe(
			callsAfterInitialResolve,
		);
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
		const options = baseOptions({
			getThreads: vi.fn().mockResolvedValue([thread]),
		});
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
			events: [
				{
					id: "event-1",
					kind: "resolved",
					by: { kind: "human", id: "u1" },
					prev: null,
				},
			],
		};
		getThreads.mockResolvedValue([resolvedThread]);

		act(() => {
			latest?.refetch();
		});
		await flush(root);

		expect(latest?.resolvedThreads).not.toBe(beforeThreads);
		expect(latest?.resolvedThreads[0]?.state).toBe("resolved");
	});

	// A brand-new comment records ProseMirror positions (buildQuoteAnchor),
	// not flattened-markdown offsets: a selection ending at the last
	// character always has PM `to` one past the markdown length, which used
	// to trip resolveAnchor's fast-path into `orphaned` on the very first
	// render after creating the thread.
	it("does not orphan a brand-new revision-mode comment at the end of the document", async () => {
		const editor = createEditor("Hello brave new world");
		const endOfText = editor.state.doc.content.size - 1;
		const quoteAnchor = buildQuoteAnchor(
			editor.state.doc,
			endOfText - 5,
			endOfText,
		);
		expect(quoteAnchor.quote).toBe("world");
		const thread: CommentThread = {
			id: "thread-1",
			opener: {
				id: "thread-1",
				by: { kind: "human", id: "u1" },
				anchor: { ...quoteAnchor, mode: "revision", revisionId: "rev-1" },
				text: "why?",
			},
			events: [],
			state: "open",
		};
		const options = baseOptions({
			getThreads: vi.fn().mockResolvedValue([thread]),
			readRevisionContent: vi.fn().mockResolvedValue("Hello brave new world"),
		});

		act(() => {
			root.render(<Harness options={options} editor={editor} />);
		});
		await flush(root);

		const resolution = latest?.resolvedThreads[0]?.anchorResolution;
		expect(resolution?.status).not.toBe("orphaned");
		expect(
			editor.state.doc.textBetween(
				resolution?.range?.from ?? 0,
				resolution?.range?.to ?? 0,
				"\n",
			),
		).toBe("world");
	});

	// The saved revision almost always lags the live draft (revisions cut on
	// idle/manual saves, not keystrokes), so a new comment's revision-replay
	// runs against differing texts with PM-space offsets -- which used to
	// orphan the thread immediately even though its quote never moved.
	it("does not orphan a new comment when unsaved edits elsewhere moved the saved revision", async () => {
		const editor = createEditor("PREFIX TARGET rest of the line");
		const quoteAnchor = buildQuoteAnchor(editor.state.doc, 8, 14);
		expect(quoteAnchor.quote).toBe("TARGET");
		const thread: CommentThread = {
			id: "thread-1",
			opener: {
				id: "thread-1",
				by: { kind: "human", id: "u1" },
				anchor: { ...quoteAnchor, mode: "revision", revisionId: "rev-1" },
				text: "why?",
			},
			events: [],
			state: "open",
		};
		const options = baseOptions({
			getThreads: vi.fn().mockResolvedValue([thread]),
			readRevisionContent: vi.fn().mockResolvedValue("TARGET rest of the line"),
		});

		act(() => {
			root.render(<Harness options={options} editor={editor} />);
		});
		await flush(root);

		const resolution = latest?.resolvedThreads[0]?.anchorResolution;
		expect(resolution?.status).not.toBe("orphaned");
		expect(
			editor.state.doc.textBetween(
				resolution?.range?.from ?? 0,
				resolution?.range?.to ?? 0,
				"\n",
			),
		).toBe("TARGET");
	});

	// Large-document editing lag: with zero threads every keystroke used to
	// serialize the whole document (`getJSON` + Markdown) before discovering
	// there was nothing to resolve. The empty fast path must do no
	// serialization work at all.
	it("does not serialize the document on edits when there are no threads", async () => {
		const options = baseOptions({
			getThreads: vi.fn().mockResolvedValue([]),
		});
		const editor = createEditor("TARGET rest of the line");

		act(() => {
			root.render(<Harness options={options} editor={editor} />);
		});
		await flush(root);
		expect(latest?.resolvedThreads).toEqual([]);

		const getJSON = vi.spyOn(editor, "getJSON");
		act(() => {
			editor.view.dispatch(editor.state.tr.insertText("x", 2));
		});
		await flush(root);

		expect(getJSON).not.toHaveBeenCalled();
		getJSON.mockRestore();
	});

	// Threads pinned to the same revision share one backing read per resolve
	// pass instead of one read (plus flatten and line diff) per thread.
	it("reads shared revision content once per resolve pass for threads on the same revision", async () => {
		const editor = createEditor("TARGET rest of the line");
		const anchor = buildQuoteAnchor(editor.state.doc, 1, 7);
		const threads: CommentThread[] = [0, 1, 2].map((index) => ({
			id: `thread-${index}`,
			opener: {
				id: `thread-${index}`,
				by: { kind: "human", id: "u1" },
				anchor: { ...anchor, mode: "revision", revisionId: "rev-1" },
				text: "why?",
			},
			events: [],
			state: "open",
		}));
		const readRevisionContent = vi
			.fn()
			.mockResolvedValue("TARGET rest of the line");
		const options = baseOptions({
			getThreads: vi.fn().mockResolvedValue(threads),
			readRevisionContent,
		});

		act(() => {
			root.render(<Harness options={options} editor={editor} />);
		});
		await flush(root);

		expect(latest?.resolvedThreads).toHaveLength(3);
		expect(readRevisionContent).toHaveBeenCalledTimes(1);

		act(() => {
			editor.view.dispatch(editor.state.tr.insertText("x", 2));
		});
		await flush(root);

		expect(latest?.resolvedThreads).toHaveLength(3);
		expect(readRevisionContent).toHaveBeenCalledTimes(2);
	});

	// Overlapping async resolve passes (rapid keystrokes) must settle on the
	// latest document, never an earlier pass's stale result.
	it("settles rapid successive edits on the latest document positions", async () => {
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
		const options = baseOptions({
			getThreads: vi.fn().mockResolvedValue([thread]),
		});
		const editor = createEditor("TARGET rest of the line");

		act(() => {
			root.render(<Harness options={options} editor={editor} />);
		});
		await flush(root);
		expect(latest?.resolvedThreads[0]?.anchorResolution.range).toEqual({
			from: 1,
			to: 7,
		});

		act(() => {
			editor.view.dispatch(
				editor.state.tr
					.setSelection(TextSelection.create(editor.state.doc, 1))
					.insertText("AA "),
			);
			editor.view.dispatch(editor.state.tr.insertText("BB ", 1));
		});
		await flush(root);

		const range = latest?.resolvedThreads[0]?.anchorResolution.range;
		expect(range).toEqual({ from: 7, to: 13 });
		expect(
			editor.state.doc.textBetween(range?.from ?? 0, range?.to ?? 0, "\n"),
		).toBe("TARGET");
	});
});
