// @vitest-environment happy-dom
import type { Editor } from "@tiptap/core";
import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentOptions, CommentThread } from "../comments/index.js";
import { EditorView, type EditorViewProps } from "./EditorView";

async function flushMicrotasks(times = 6) {
	for (let i = 0; i < times; i++) {
		// eslint-disable-next-line no-await-in-loop
		await act(async () => {
			await Promise.resolve();
		});
	}
}

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * R18 regression guard: `onOpenRevisionHistory` (Slice 3) is an opt-in prop,
 * same convention as `onIdleOrForcedCut` (Slice 1). `apps/www` and
 * `apps/notion-web` never pass it, so this proves that omitting it leaves
 * EditorView's pre-existing external-content-reload behavior (the
 * `initialMarkdown`-changed effect) completely unchanged, and renders no new
 * UI either.
 */
describe("EditorView external-content reload, prop omitted (R18)", () => {
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

	function baseProps(
		overrides: Partial<EditorViewProps> = {},
	): EditorViewProps {
		return {
			path: "/workspace/note.md",
			initialMarkdown: "Hello world\n",
			onLocalChange: vi.fn(),
			onSave: vi.fn(),
			onOpenExternalLink: vi.fn(),
			onOpenWikiLink: vi.fn(),
			...overrides,
		};
	}

	it("still silently swaps in new initialMarkdown content with no new UI rendered", () => {
		const props = baseProps();
		act(() => {
			root.render(<EditorView {...props} />);
		});

		expect(container.textContent).toContain("Hello world");
		expect(
			container.querySelector("[data-revision-history-trigger]"),
		).toBeNull();

		act(() => {
			root.render(
				<EditorView {...props} initialMarkdown="Changed outside\n" />,
			);
		});

		expect(container.textContent).toContain("Changed outside");
		expect(container.textContent).not.toContain("Hello world");
		expect(
			container.querySelector("[data-revision-history-trigger]"),
		).toBeNull();
	});

	it("renders the history affordance only when onOpenRevisionHistory is provided", () => {
		const onOpenRevisionHistory = vi.fn();
		act(() => {
			root.render(
				<EditorView
					{...baseProps()}
					onOpenRevisionHistory={onOpenRevisionHistory}
				/>,
			);
		});

		const trigger = container.querySelector<HTMLButtonElement>(
			"[data-revision-history-trigger]",
		);
		expect(trigger).not.toBeNull();
		act(() => trigger?.click());
		expect(onOpenRevisionHistory).toHaveBeenCalledWith("/workspace/note.md");
	});
});

/**
 * R31: apps/www sets `editable={false}` to make the web review surface
 * read-only. This proves both directions of the contract: the default
 * (`editable` omitted) leaves every existing consumer — the desktop app,
 * `apps/notion-web`, the vendored second consumer — completely unaffected,
 * while `editable={false}` (a) actually flips ProseMirror's own DOM
 * `contenteditable` attribute and (b) closes off `onSave` even for a
 * programmatic doc mutation dispatched with "recent user edit intent" set
 * (the same mechanism a UI control like Find & Replace's "Replace" button
 * would trigger) — not just for literal keystrokes.
 */
describe("EditorView editable prop (R31)", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		vi.useFakeTimers();
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.useRealTimers();
	});

	function baseProps(
		overrides: Partial<EditorViewProps> = {},
	): EditorViewProps {
		return {
			path: "/workspace/note.md",
			initialMarkdown: "Hello world\n",
			onLocalChange: vi.fn(),
			onSave: vi.fn(),
			onOpenExternalLink: vi.fn(),
			onOpenWikiLink: vi.fn(),
			...overrides,
		};
	}

	/** Sets "recent user edit intent" (mirrors a real pointerdown/keydown on the editor root) so the onUpdate handler's `scheduleSave()` call is actually reached, then inserts text directly via the live editor's own transaction API — bypassing ProseMirror's `contenteditable` gate entirely, the same way an in-editor control (e.g. Find & Replace's "Replace" button) would. */
	function editViaEditorCommand(editor: Editor) {
		const root = container.querySelector<HTMLElement>("[data-hubble-editor]");
		act(() => {
			root?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
			editor.commands.insertContentAt(0, "EDITED ");
		});
	}

	it("defaults to editable — today's behaviour, unaffected when the prop is omitted", () => {
		act(() => {
			root.render(<EditorView {...baseProps()} />);
		});
		const pmRoot = container.querySelector("[contenteditable]");
		expect(pmRoot).not.toBeNull();
		expect(pmRoot?.getAttribute("contenteditable")).toBe("true");
	});

	it("editable={true} (explicit) still reaches onSave on the autosave debounce, proving the test's own mechanism is real", () => {
		const onSave = vi.fn();
		let liveEditor: Editor | null = null;
		act(() => {
			root.render(
				<EditorView
					{...baseProps({ onSave, onEditorReady: (e) => (liveEditor = e) })}
					editable={true}
				/>,
			);
		});
		if (!liveEditor) throw new Error("editor did not become ready");
		editViaEditorCommand(liveEditor);
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(onSave).toHaveBeenCalled();
	});

	it("editable={false} sets contenteditable=false and never calls onSave, even for a programmatic transaction with recent edit intent", () => {
		const onSave = vi.fn();
		const onLocalChange = vi.fn();
		let liveEditor: Editor | null = null;
		act(() => {
			root.render(
				<EditorView
					{...baseProps({
						onSave,
						onLocalChange,
						onEditorReady: (e) => (liveEditor = e),
					})}
					editable={false}
				/>,
			);
		});
		const pmRoot = container.querySelector("[contenteditable]");
		expect(pmRoot?.getAttribute("contenteditable")).toBe("false");
		if (!liveEditor) throw new Error("editor did not become ready");

		editViaEditorCommand(liveEditor);
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(onSave).not.toHaveBeenCalled();

		// Unmount is the other onSave call site (the forced-cut save on
		// path-change/unmount) — never reached either, because `editable=false`
		// means `scheduleSave` never set `saveTimerRef` in the first place.
		act(() => root.unmount());
		expect(onSave).not.toHaveBeenCalled();
	});
});

/**
 * QA regression guard: a successful comment mutation (reply/resolve/reopen/
 * open) must re-fetch threads on its own, not rely on some unrelated prop
 * change (e.g. toggling the panel open) to incidentally retrigger
 * `useCommentThreads`'s fetch effect. Before this fix, resolving a thread
 * wrote successfully but the panel kept showing it as open until the
 * document was closed and reopened.
 */
describe("EditorView comment mutations re-fetch threads (QA finding)", () => {
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

	function baseProps(
		overrides: Partial<EditorViewProps> = {},
	): EditorViewProps {
		return {
			path: "/workspace/note.md",
			initialMarkdown: "Hello world\n",
			onLocalChange: vi.fn(),
			onSave: vi.fn(),
			onOpenExternalLink: vi.fn(),
			onOpenWikiLink: vi.fn(),
			...overrides,
		};
	}

	it("re-fetches and re-renders the panel after a resolve action succeeds, with no other prop change", async () => {
		const openThread: CommentThread = {
			id: "thread-1",
			opener: {
				id: "thread-1",
				by: { kind: "human", id: "u1" },
				anchor: { from: 0, to: 5, quote: "Hello", mode: "quote" },
				text: "why?",
			},
			events: [],
			state: "open",
		};
		const resolvedThread: CommentThread = { ...openThread, state: "resolved" };
		const getThreads = vi
			.fn()
			.mockResolvedValueOnce([openThread])
			.mockResolvedValue([resolvedThread]);
		const onResolve = vi.fn().mockResolvedValue(undefined);
		const commentOptions: CommentOptions = {
			currentAuthor: { kind: "human", id: "u1" },
			docId: "doc-1",
			getHeadRevisionId: () => Promise.resolve(null),
			getThreads,
			readRevisionContent: () => Promise.resolve(null),
			onOpenThread: vi.fn(),
			onReply: vi.fn(),
			onResolve,
			onReopen: vi.fn(),
			onDelete: vi.fn(),
			panelOpen: true,
			// `ThreadPanel` only honors the controlled `open` prop when
			// `onPanelOpenChange` is also supplied (see its `isControlled` check)
			// -- otherwise it falls back to its own internal, always-closed state.
			onPanelOpenChange: vi.fn(),
		};

		act(() => {
			root.render(<EditorView {...baseProps({ commentOptions })} />);
		});
		await flushMicrotasks();

		// `ThreadPanel` renders inside `SidePanel`, which portals into
		// `document.body` directly (no `PortalContainerProvider` here) rather
		// than under `container` -- query the document, not the container.
		expect(
			document.querySelector('[data-comment-thread][data-thread-state="open"]'),
		).not.toBeNull();

		await act(async () => {
			document
				.querySelector<HTMLButtonElement>("[data-resolve-button]")
				?.click();
		});
		await flushMicrotasks();

		expect(onResolve).toHaveBeenCalledWith("thread-1");
		expect(getThreads).toHaveBeenCalledTimes(2);
		expect(
			document.querySelector(
				'[data-comment-thread][data-thread-state="resolved"]',
			),
		).not.toBeNull();
	});
});

function baseCommentOptions(
	overrides: Partial<CommentOptions> = {},
): CommentOptions {
	return {
		currentAuthor: { kind: "human", id: "u1" },
		docId: "doc-1",
		getHeadRevisionId: () => Promise.resolve(null),
		getThreads: () => Promise.resolve([]),
		readRevisionContent: () => Promise.resolve(null),
		onOpenThread: vi.fn().mockResolvedValue(undefined),
		onReply: vi.fn().mockResolvedValue(undefined),
		onResolve: vi.fn().mockResolvedValue(undefined),
		onReopen: vi.fn().mockResolvedValue(undefined),
		onDelete: vi.fn().mockResolvedValue(undefined),
		panelOpen: true,
		onPanelOpenChange: vi.fn(),
		...overrides,
	};
}

/**
 * QA finding #2: the desktop app's "only one right-edge panel open at a
 * time" rule (R21) force-closes the comment panel from OUTSIDE
 * `ThreadPanel`'s own `onOpenChange` -- it flips the host's `panelOpen` state
 * straight to `false` (e.g. when Revision History opens) rather than routing
 * through the panel's Close/Escape/Cancel path. Before this fix, that left
 * the in-progress draft, its pending-highlight decoration, and the hidden
 * "+Comment" trigger all stuck, with no way to dismiss them short of
 * reopening the panel and finding the buried Cancel button.
 */
describe("EditorView comment composing cleared by an external panel force-close (QA finding #2)", () => {
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

	function baseProps(
		overrides: Partial<EditorViewProps> = {},
	): EditorViewProps {
		return {
			path: "/workspace/note.md",
			initialMarkdown: "Hello world\n",
			onLocalChange: vi.fn(),
			onSave: vi.fn(),
			onOpenExternalLink: vi.fn(),
			onOpenWikiLink: vi.fn(),
			...overrides,
		};
	}

	it("clears the pending-highlight decoration and re-shows the +Comment trigger when the host force-closes the panel directly", async () => {
		let liveEditor: Editor | null = null;
		const commentOptions = baseCommentOptions();
		act(() => {
			root.render(
				<EditorView
					{...baseProps({
						commentOptions,
						onEditorReady: (e) => (liveEditor = e),
					})}
				/>,
			);
		});
		await flushMicrotasks();
		if (!liveEditor) throw new Error("editor did not become ready");

		// Select "world" and start composing a new draft on it.
		act(() => {
			(liveEditor as Editor).commands.setTextSelection({ from: 7, to: 12 });
		});
		await act(async () => {
			container
				.querySelector<HTMLButtonElement>("[data-comment-composer-trigger]")
				?.click();
		});
		await flushMicrotasks();

		expect(
			(liveEditor as Editor).view.dom.querySelector(".pm-comment-mark-pending"),
		).not.toBeNull();
		expect(
			container.querySelector("[data-comment-composer-trigger]"),
		).toBeNull();

		// Mirrors `apps/desktop/src/App.tsx`'s R21 handler: the host flips
		// `panelOpen` to `false` directly, never calling this panel's own
		// `onOpenChange`/`onPanelOpenChange`.
		act(() => {
			root.render(
				<EditorView
					{...baseProps({
						commentOptions: { ...commentOptions, panelOpen: false },
						onEditorReady: (e) => (liveEditor = e),
					})}
				/>,
			);
		});
		await flushMicrotasks();

		expect(
			(liveEditor as Editor).view.dom.querySelector(".pm-comment-mark-pending"),
		).toBeNull();

		// `CommentComposer` itself remounted (it was unmounted while
		// `composingAnchor ? null : <CommentComposer />` was hiding it) and
		// only computes its trigger's position reactively, off a
		// "selectionUpdate"/"transaction" event -- so a fresh selection change
		// is what proves it's mounted and no longer suppressed by a stuck
		// composing state, not the unchanged pre-existing selection alone.
		act(() => {
			(liveEditor as Editor).commands.setTextSelection({ from: 7, to: 11 });
		});
		expect(
			container.querySelector("[data-comment-composer-trigger]"),
		).not.toBeNull();
	});
});

/**
 * QA finding #3: clicking an existing comment mark while a new-comment draft
 * is open used to leave both highlights showing at once (the pending-anchor
 * decoration for the unfinished draft, and the newly-focused thread's own
 * highlight), with the composer UI still mounted alongside the now-focused
 * thread. Focusing an existing thread should implicitly cancel the draft
 * first -- one active "thing being highlighted" at a time.
 */
describe("EditorView selecting an existing thread cancels an in-progress draft (QA finding #3)", () => {
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

	function baseProps(
		overrides: Partial<EditorViewProps> = {},
	): EditorViewProps {
		return {
			path: "/workspace/note.md",
			initialMarkdown: "Hello world\n",
			onLocalChange: vi.fn(),
			onSave: vi.fn(),
			onOpenExternalLink: vi.fn(),
			onOpenWikiLink: vi.fn(),
			...overrides,
		};
	}

	it("cancels the pending draft and focuses the clicked thread instead of showing both highlights", async () => {
		const existingThread: CommentThread = {
			id: "thread-1",
			opener: {
				id: "thread-1",
				by: { kind: "human", id: "u1" },
				anchor: { from: 0, to: 5, quote: "Hello", mode: "quote" },
				text: "why?",
			},
			events: [],
			state: "open",
		};
		let liveEditor: Editor | null = null;
		const commentOptions = baseCommentOptions({
			getThreads: () => Promise.resolve([existingThread]),
		});
		act(() => {
			root.render(
				<EditorView
					{...baseProps({
						commentOptions,
						onEditorReady: (e) => (liveEditor = e),
					})}
				/>,
			);
		});
		await flushMicrotasks();
		if (!liveEditor) throw new Error("editor did not become ready");

		// Start a new-comment draft on "world" -- a different range from the
		// existing thread's "Hello".
		act(() => {
			(liveEditor as Editor).commands.setTextSelection({ from: 7, to: 12 });
		});
		await act(async () => {
			container
				.querySelector<HTMLButtonElement>("[data-comment-composer-trigger]")
				?.click();
		});
		await flushMicrotasks();
		expect(
			(liveEditor as Editor).view.dom.querySelector(".pm-comment-mark-pending"),
		).not.toBeNull();

		// A plain click needs a collapsed selection at click time (see
		// `useCommentMarkClick`'s own guard against drag-selection mouseups).
		act(() => {
			(liveEditor as Editor).commands.setTextSelection({ from: 0, to: 0 });
		});
		const existingMark = (
			liveEditor as Editor
		).view.dom.querySelector<HTMLElement>(
			'.pm-comment-mark[data-thread-id="thread-1"]',
		);
		expect(existingMark).not.toBeNull();
		act(() => {
			existingMark?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		await flushMicrotasks();

		// The draft's pending highlight is gone...
		expect(
			(liveEditor as Editor).view.dom.querySelector(".pm-comment-mark-pending"),
		).toBeNull();
		// ...and the clicked thread is now focused in the panel instead.
		expect(
			document.querySelector(
				'[data-comment-thread][data-thread-id="thread-1"][data-thread-focused="true"]',
			),
		).not.toBeNull();
	});
});
