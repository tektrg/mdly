// @vitest-environment happy-dom

import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { act, useRef } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tiptapDocToMarkdown } from "../../engine/index.js";
import { CommentComposer } from "../CommentComposer";
import type { TextAnchor } from "../types.js";

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

function Harness({
	editor,
	onStartComposing,
	getHeadRevisionId = () => Promise.resolve(null),
	readRevisionContent = () => Promise.resolve(null),
}: {
	editor: Editor;
	onStartComposing: (
		anchor: TextAnchor,
		quoteText: string,
		range: { from: number; to: number },
	) => void;
	getHeadRevisionId?: () => Promise<string | null>;
	readRevisionContent?: (revisionId: string) => Promise<string | null>;
}) {
	const viewportRef = useRef<HTMLDivElement | null>(null);
	return (
		<div ref={viewportRef}>
			<CommentComposer
				editor={editor}
				viewportRef={viewportRef}
				getHeadRevisionId={getHeadRevisionId}
				readRevisionContent={readRevisionContent}
				onStartComposing={onStartComposing}
			/>
		</div>
	);
}

async function flushMicrotasks(times = 3) {
	for (let i = 0; i < times; i++) {
		// eslint-disable-next-line no-await-in-loop
		await act(async () => {
			await Promise.resolve();
		});
	}
}

describe("CommentComposer", () => {
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

	it("shows no trigger while the selection is collapsed", () => {
		const editor = createEditor();
		act(() => {
			root.render(<Harness editor={editor} onStartComposing={vi.fn()} />);
		});

		expect(
			container.querySelector("[data-comment-composer-trigger]"),
		).toBeNull();
	});

	it("shows a Comment trigger and a copy-link trigger once text is selected", () => {
		const editor = createEditor();
		act(() => {
			root.render(<Harness editor={editor} onStartComposing={vi.fn()} />);
		});

		act(() => {
			editor.commands.setTextSelection({ from: 1, to: 6 });
		});

		expect(
			container.querySelector("[data-comment-composer-trigger]"),
		).not.toBeNull();
		expect(container.querySelector("[data-comment-copy-link]")).not.toBeNull();
	});

	// The trigger renders an icon only (no visible text) -- its accessible
	// name must come from aria-label/title instead, or it's silently
	// unlabeled for screen readers.
	it("labels both icon-only triggers with an accessible name", () => {
		const editor = createEditor();
		act(() => {
			root.render(<Harness editor={editor} onStartComposing={vi.fn()} />);
		});
		act(() => {
			editor.commands.setTextSelection({ from: 1, to: 6 });
		});

		const trigger = container.querySelector<HTMLButtonElement>(
			"[data-comment-composer-trigger]",
		);
		expect(trigger?.getAttribute("aria-label")).toBe("Comment");
		expect(trigger?.textContent?.trim()).toBe("");

		const copyLink = container.querySelector<HTMLButtonElement>(
			"[data-comment-copy-link]",
		);
		expect(copyLink?.getAttribute("aria-label")).toBe("Copy link to selection");
	});

	it("builds a quote-mode anchor from the exact selection and starts composing", async () => {
		const onStartComposing = vi.fn();
		const editor = createEditor();
		act(() => {
			root.render(
				<Harness editor={editor} onStartComposing={onStartComposing} />,
			);
		});
		act(() => {
			editor.commands.setTextSelection({ from: 1, to: 6 });
		});

		await act(async () => {
			container
				.querySelector<HTMLButtonElement>("[data-comment-composer-trigger]")
				?.click();
		});
		await flushMicrotasks();

		expect(onStartComposing).toHaveBeenCalledTimes(1);
		const [anchor, quoteText, range] = onStartComposing.mock.calls[0] as [
			TextAnchor,
			string,
			{ from: number; to: number },
		];
		expect(anchor.mode).toBe("quote");
		expect(anchor.quote).toBe("Hello");
		expect(quoteText).toBe("Hello");
		expect(range).toEqual({ from: 1, to: 6 });
	});

	// R10: a new comment on a note whose live text is byte-identical to its
	// head revision gets the more durable 'revision' anchor mode, not always
	// 'quote'.
	it("builds a revision-mode anchor when the live body matches the head revision", async () => {
		const onStartComposing = vi.fn();
		const editor = createEditor();
		const currentBody = tiptapDocToMarkdown(editor.getJSON() as JSONContent);
		const readRevisionContent = vi
			.fn()
			.mockImplementation((revisionId: string) =>
				Promise.resolve(
					revisionId === "rev-1" ? currentBody : "different text",
				),
			);
		act(() => {
			root.render(
				<Harness
					editor={editor}
					onStartComposing={onStartComposing}
					getHeadRevisionId={() => Promise.resolve("rev-1")}
					readRevisionContent={readRevisionContent}
				/>,
			);
		});
		act(() => {
			editor.commands.setTextSelection({ from: 1, to: 6 });
		});

		await act(async () => {
			container
				.querySelector<HTMLButtonElement>("[data-comment-composer-trigger]")
				?.click();
		});
		await flushMicrotasks();

		expect(readRevisionContent).toHaveBeenCalledWith("rev-1");
		const [anchor] = onStartComposing.mock.calls[0] as [TextAnchor];
		expect(anchor.mode).toBe("revision");
		expect(anchor.revisionId).toBe("rev-1");
	});

	// R10 regression guard: `getHeadRevisionId` must be re-resolved on every
	// click, never cached across the composer's lifetime -- the editor mints
	// a new head revision mid-session on its own (idle/forced cuts), so a
	// value snapshotted once would go stale.
	it("resolves getHeadRevisionId fresh on every trigger click rather than caching it", async () => {
		const onStartComposing = vi.fn();
		const editor = createEditor();
		let currentHeadRevisionId = "rev-1";
		const getHeadRevisionId = vi
			.fn()
			.mockImplementation(() => Promise.resolve(currentHeadRevisionId));
		const readRevisionContent = vi
			.fn()
			.mockImplementation(() => Promise.resolve("never matches"));
		act(() => {
			root.render(
				<Harness
					editor={editor}
					onStartComposing={onStartComposing}
					getHeadRevisionId={getHeadRevisionId}
					readRevisionContent={readRevisionContent}
				/>,
			);
		});

		const click = async () => {
			act(() => {
				editor.commands.setTextSelection({ from: 1, to: 6 });
			});
			await act(async () => {
				container
					.querySelector<HTMLButtonElement>("[data-comment-composer-trigger]")
					?.click();
			});
			await flushMicrotasks();
		};

		await click();
		expect(readRevisionContent).toHaveBeenLastCalledWith("rev-1");

		// A revision cut happens mid-session -- the head moves to "rev-2" with
		// no re-mount and no new prop passed down, only the callback's own
		// return value changing.
		currentHeadRevisionId = "rev-2";
		await click();

		expect(getHeadRevisionId).toHaveBeenCalledTimes(2);
		expect(readRevisionContent).toHaveBeenLastCalledWith("rev-2");
	});

	it("copies a text-fragment link for the selection to the clipboard", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		const editor = createEditor();
		act(() => {
			root.render(<Harness editor={editor} onStartComposing={vi.fn()} />);
		});
		act(() => {
			editor.commands.setTextSelection({ from: 1, to: 6 });
		});

		await act(async () => {
			container
				.querySelector<HTMLButtonElement>("[data-comment-copy-link]")
				?.click();
		});

		expect(writeText).toHaveBeenCalledTimes(1);
		expect(writeText.mock.calls[0]?.[0]).toContain("Hello");
	});

	it("positions the toolbar relative to the scrolled viewport, not the unscrolled one", () => {
		const editor = createEditor();
		vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({
			top: 10,
			bottom: 20,
			left: 5,
			right: 5,
		});

		act(() => {
			root.render(<Harness editor={editor} onStartComposing={vi.fn()} />);
		});

		const viewport = container.firstElementChild as HTMLDivElement;
		vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
			top: 100,
			left: 50,
			bottom: 0,
			right: 0,
			width: 0,
			height: 0,
			x: 0,
			y: 0,
			toJSON: () => {},
		});
		Object.defineProperty(viewport, "scrollTop", {
			value: 40,
			writable: true,
		});
		Object.defineProperty(viewport, "scrollLeft", {
			value: 15,
			writable: true,
		});

		act(() => {
			editor.commands.setTextSelection({ from: 1, to: 6 });
		});

		const toolbar = container.querySelector<HTMLElement>(
			"[data-comment-selection-toolbar]",
		);
		expect(toolbar?.style.top).toBe("-40px");
		expect(toolbar?.style.left).toBe("-30px");

		Object.defineProperty(viewport, "scrollTop", { value: 90 });
		act(() => {
			viewport.dispatchEvent(new Event("scroll"));
		});

		expect(
			container.querySelector<HTMLElement>("[data-comment-selection-toolbar]")
				?.style.top,
		).toBe("10px");
	});
});
