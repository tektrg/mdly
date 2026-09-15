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
		const listeners = new Map<string, Set<() => void>>();
		const getText = vi.fn(() => "hello world");
		const editor = {
			getText,
			isFocused: false,
			state: { selection: { empty: true } },
			view: { dom: document.createElement("div") },
			on(event: string, callback: () => void) {
				if (!listeners.has(event)) listeners.set(event, new Set());
				listeners.get(event)?.add(callback);
			},
			off(event: string, callback: () => void) {
				listeners.get(event)?.delete(callback);
			},
			emit(event: string) {
				for (const callback of listeners.get(event) ?? []) callback();
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

	it("still recomputes word count on real editor transactions", () => {
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

		expect(getText).toHaveBeenCalledTimes(1);
	});
});
