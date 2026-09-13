// @vitest-environment happy-dom
import type { Editor } from "@tiptap/core";
import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FormattingStatusBar } from "./FormattingStatusBar";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Regression guard: opening a large file used to freeze the app. Root cause
 * (see mdly hang investigation) was this component recomputing the
 * whole-document word count on every `window` scroll/resize event, uncapped
 * — a scroll burst (e.g. auto-scroll on file open) triggered `editor.getText()`
 * fast enough, and expensively enough on a large doc, to never let the
 * render loop settle. Word/char count and caret formatting only ever depend
 * on document content and selection, never on scroll position or viewport
 * size, so the fix removes those listeners outright rather than throttling
 * them.
 */
describe("FormattingStatusBar scroll/resize hang (R-hang-1)", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	function createFakeEditor() {
		const listeners = new Map<string, Set<(payload?: unknown) => void>>();
		const getText = vi.fn(() => "hello world");
		const editor = {
			getText,
			isFocused: false,
			state: { selection: { empty: true } },
			view: { dom: document.createElement("div") },
			on(event: string, callback: (payload?: unknown) => void) {
				if (!listeners.has(event)) listeners.set(event, new Set());
				listeners.get(event)?.add(callback);
			},
			off(event: string, callback: (payload?: unknown) => void) {
				listeners.get(event)?.delete(callback);
			},
			emit(event: string, payload?: unknown) {
				for (const callback of listeners.get(event) ?? []) callback(payload);
			},
		};
		return { editor: editor as unknown as Editor, getText };
	}

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it("does not recompute word count on window scroll or resize", () => {
		const { editor, getText } = createFakeEditor();

		act(() => {
			root.render(
				<FormattingStatusBar editor={editor} path="/workspace/note.md" />,
			);
		});
		getText.mockClear();

		act(() => {
			window.dispatchEvent(new Event("scroll"));
			window.dispatchEvent(new Event("resize"));
		});

		expect(getText).not.toHaveBeenCalled();
	});

	it("recomputes word count two seconds after a real editor transaction", () => {
		vi.useFakeTimers();
		try {
			const { editor, getText } = createFakeEditor();

			act(() => {
				root.render(
					<FormattingStatusBar editor={editor} path="/workspace/note.md" />,
				);
			});
			getText.mockClear();

			act(() => {
				(editor as unknown as { emit: (event: string) => void }).emit(
					"transaction",
				);
			});

			expect(getText).not.toHaveBeenCalled();
			act(() => vi.advanceTimersByTime(2_000));
			expect(getText).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not recount the document on cursor-only selection updates", () => {
		const { editor, getText } = createFakeEditor();

		act(() => {
			root.render(
				<FormattingStatusBar editor={editor} path="/workspace/note.md" />,
			);
		});
		getText.mockClear();

		act(() => {
			(editor as unknown as { emit: (event: string) => void }).emit(
				"selectionUpdate",
			);
		});

		expect(getText).not.toHaveBeenCalled();
	});

	it("does not recount on transactions that leave content unchanged", () => {
		const { editor, getText } = createFakeEditor();

		act(() => {
			root.render(
				<FormattingStatusBar editor={editor} path="/workspace/note.md" />,
			);
		});
		getText.mockClear();

		act(() => {
			(
				editor as unknown as {
					emit: (event: string, payload?: unknown) => void;
				}
			).emit("transaction", { transaction: { docChanged: false } });
		});

		expect(getText).not.toHaveBeenCalled();
	});

	it("recounts once when a keystroke fires both selectionUpdate and a content transaction", () => {
		vi.useFakeTimers();
		try {
			const { editor, getText } = createFakeEditor();

			act(() => {
				root.render(
					<FormattingStatusBar editor={editor} path="/workspace/note.md" />,
				);
			});
			getText.mockClear();

			act(() => {
				const emitter = editor as unknown as {
					emit: (event: string, payload?: unknown) => void;
				};
				emitter.emit("selectionUpdate");
				emitter.emit("transaction", { transaction: { docChanged: true } });
			});

			expect(getText).not.toHaveBeenCalled();
			act(() => vi.advanceTimersByTime(2_000));
			expect(getText).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("defers and collapses whole-document recounts until typing has been idle for two seconds", () => {
		vi.useFakeTimers();
		try {
			const { editor, getText } = createFakeEditor();

			act(() => {
				root.render(
					<FormattingStatusBar editor={editor} path="/workspace/note.md" />,
				);
				vi.advanceTimersByTime(20);
			});
			getText.mockClear();

			act(() => {
				const emitter = editor as unknown as {
					emit: (event: string, payload?: unknown) => void;
				};
				emitter.emit("transaction", { transaction: { docChanged: true } });
				vi.advanceTimersByTime(1_000);
				emitter.emit("transaction", { transaction: { docChanged: true } });
				vi.advanceTimersByTime(1_999);
			});

			expect(getText).not.toHaveBeenCalled();

			act(() => vi.advanceTimersByTime(1));

			expect(getText).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
