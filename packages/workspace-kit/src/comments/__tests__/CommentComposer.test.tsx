// @vitest-environment happy-dom

import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { act, useRef } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tiptapDocToMarkdown } from "../../engine/index.js";
import { CommentComposer } from "../CommentComposer";

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
	onOpenThread,
	onPanelOpenChange,
	getHeadRevisionId = () => Promise.resolve(null),
	readRevisionContent = () => Promise.resolve(null),
}: {
	editor: Editor;
	onOpenThread: (anchor: unknown, text: string) => Promise<void>;
	onPanelOpenChange?: (open: boolean) => void;
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
				onOpenThread={onOpenThread}
				onPanelOpenChange={onPanelOpenChange}
			/>
		</div>
	);
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
			root.render(<Harness editor={editor} onOpenThread={vi.fn()} />);
		});

		expect(container.querySelector("[data-comment-composer-trigger]")).toBeNull();
	});

	it("shows a trigger once text is selected, and a compose box once clicked", () => {
		const editor = createEditor();
		act(() => {
			root.render(<Harness editor={editor} onOpenThread={vi.fn()} />);
		});

		act(() => {
			editor.commands.setTextSelection({ from: 1, to: 6 });
		});

		const trigger = container.querySelector<HTMLButtonElement>(
			"[data-comment-composer-trigger]",
		);
		expect(trigger).not.toBeNull();
		expect(container.querySelector("[data-comment-composer]")).toBeNull();

		act(() => trigger?.click());

		expect(container.querySelector("[data-comment-composer]")).not.toBeNull();
		expect(
			container.querySelector<HTMLButtonElement>("[data-comment-composer-submit]")
				?.disabled,
		).toBe(true);
	});

	it("submits a quote-mode anchor built from the exact selection and clears the draft", async () => {
		const onOpenThread = vi.fn().mockResolvedValue(undefined);
		const editor = createEditor();
		act(() => {
			root.render(<Harness editor={editor} onOpenThread={onOpenThread} />);
		});
		act(() => {
			editor.commands.setTextSelection({ from: 1, to: 6 });
		});
		act(() => {
			container
				.querySelector<HTMLButtonElement>("[data-comment-composer-trigger]")
				?.click();
		});

		const textarea = container.querySelector<HTMLTextAreaElement>(
			"[data-comment-composer-textarea]",
		);
		expect(textarea).not.toBeNull();

		// React overrides the plain `.value` setter on the element instance to
		// track controlled-input state, so a bare assignment followed by
		// dispatching "input" is silently ignored -- go through the native
		// prototype setter instead, which is the standard bypass for driving a
		// controlled input from outside React's own event system.
		const nativeValueSetter = Object.getOwnPropertyDescriptor(
			window.HTMLTextAreaElement.prototype,
			"value",
		)?.set;
		act(() => {
			nativeValueSetter?.call(textarea, "why bold?");
			textarea?.dispatchEvent(new Event("input", { bubbles: true }));
		});

		await act(async () => {
			container
				.querySelector<HTMLButtonElement>("[data-comment-composer-submit]")
				?.click();
		});

		expect(onOpenThread).toHaveBeenCalledTimes(1);
		const [anchor, text] = onOpenThread.mock.calls[0] as [
			{ quote: string; mode: string },
			string,
		];
		expect(anchor.mode).toBe("quote");
		expect(anchor.quote).toBe("Hello");
		expect(text).toBe("why bold?");

		// Compose box collapses back to a bare trigger once submitted.
		expect(container.querySelector("[data-comment-composer]")).toBeNull();
		expect(container.querySelector("[data-comment-composer-trigger]")).not.toBeNull();
	});

	// R10: a new comment on a note whose live text is byte-identical to its
	// head revision gets the more durable 'revision' anchor mode, not always
	// 'quote'.
	it("submits a revision-mode anchor when the live body matches the head revision", async () => {
		const onOpenThread = vi.fn().mockResolvedValue(undefined);
		const editor = createEditor();
		const currentBody = tiptapDocToMarkdown(editor.getJSON() as JSONContent);
		const readRevisionContent = vi
			.fn()
			.mockImplementation((revisionId: string) =>
				Promise.resolve(revisionId === "rev-1" ? currentBody : "different text"),
			);
		act(() => {
			root.render(
				<Harness
					editor={editor}
					onOpenThread={onOpenThread}
					getHeadRevisionId={() => Promise.resolve("rev-1")}
					readRevisionContent={readRevisionContent}
				/>,
			);
		});
		act(() => {
			editor.commands.setTextSelection({ from: 1, to: 6 });
		});
		act(() => {
			container
				.querySelector<HTMLButtonElement>("[data-comment-composer-trigger]")
				?.click();
		});
		const nativeValueSetter = Object.getOwnPropertyDescriptor(
			window.HTMLTextAreaElement.prototype,
			"value",
		)?.set;
		act(() => {
			const textarea = container.querySelector<HTMLTextAreaElement>(
				"[data-comment-composer-textarea]",
			);
			nativeValueSetter?.call(textarea, "matches head revision");
			textarea?.dispatchEvent(new Event("input", { bubbles: true }));
		});

		await act(async () => {
			container
				.querySelector<HTMLButtonElement>("[data-comment-composer-submit]")
				?.click();
		});

		expect(readRevisionContent).toHaveBeenCalledWith("rev-1");
		const [anchor] = onOpenThread.mock.calls[0] as [
			{ mode: string; revisionId?: string },
			string,
		];
		expect(anchor.mode).toBe("revision");
		expect(anchor.revisionId).toBe("rev-1");
	});

	it("falls back to quote mode when the live body differs from the head revision", async () => {
		const onOpenThread = vi.fn().mockResolvedValue(undefined);
		const editor = createEditor();
		const readRevisionContent = vi
			.fn()
			.mockResolvedValue("this is not the current body");
		act(() => {
			root.render(
				<Harness
					editor={editor}
					onOpenThread={onOpenThread}
					getHeadRevisionId={() => Promise.resolve("rev-1")}
					readRevisionContent={readRevisionContent}
				/>,
			);
		});
		act(() => {
			editor.commands.setTextSelection({ from: 1, to: 6 });
		});
		act(() => {
			container
				.querySelector<HTMLButtonElement>("[data-comment-composer-trigger]")
				?.click();
		});
		const nativeValueSetter = Object.getOwnPropertyDescriptor(
			window.HTMLTextAreaElement.prototype,
			"value",
		)?.set;
		act(() => {
			const textarea = container.querySelector<HTMLTextAreaElement>(
				"[data-comment-composer-textarea]",
			);
			nativeValueSetter?.call(textarea, "still unsaved");
			textarea?.dispatchEvent(new Event("input", { bubbles: true }));
		});

		await act(async () => {
			container
				.querySelector<HTMLButtonElement>("[data-comment-composer-submit]")
				?.click();
		});

		const [anchor] = onOpenThread.mock.calls[0] as [
			{ mode: string; revisionId?: string },
			string,
		];
		expect(anchor.mode).toBe("quote");
		expect(anchor.revisionId).toBeUndefined();
	});

	// R10 regression guard: `getHeadRevisionId` must be re-resolved on every
	// submit, never cached across the composer's lifetime -- the editor mints
	// a new head revision mid-session on its own (idle/forced cuts), so a
	// value snapshotted once would go stale.
	it("resolves getHeadRevisionId fresh on every submit rather than caching it", async () => {
		const onOpenThread = vi.fn().mockResolvedValue(undefined);
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
					onOpenThread={onOpenThread}
					getHeadRevisionId={getHeadRevisionId}
					readRevisionContent={readRevisionContent}
				/>,
			);
		});

		const nativeValueSetter = Object.getOwnPropertyDescriptor(
			window.HTMLTextAreaElement.prototype,
			"value",
		)?.set;
		const openAndSubmit = async (text: string) => {
			act(() => {
				editor.commands.setTextSelection({ from: 1, to: 6 });
			});
			act(() => {
				container
					.querySelector<HTMLButtonElement>("[data-comment-composer-trigger]")
					?.click();
			});
			act(() => {
				const textarea = container.querySelector<HTMLTextAreaElement>(
					"[data-comment-composer-textarea]",
				);
				nativeValueSetter?.call(textarea, text);
				textarea?.dispatchEvent(new Event("input", { bubbles: true }));
			});
			await act(async () => {
				container
					.querySelector<HTMLButtonElement>("[data-comment-composer-submit]")
					?.click();
			});
		};

		await openAndSubmit("first comment");
		expect(readRevisionContent).toHaveBeenLastCalledWith("rev-1");

		// A revision cut happens mid-session -- the head moves to "rev-2" with
		// no re-mount and no new prop passed down, only the callback's own
		// return value changing.
		currentHeadRevisionId = "rev-2";
		await openAndSubmit("second comment");

		expect(getHeadRevisionId).toHaveBeenCalledTimes(2);
		expect(readRevisionContent).toHaveBeenLastCalledWith("rev-2");
	});

	// R13: a failed write (e.g. a read-only workspace) must surface visibly
	// in the composer, not fail silently while quietly re-enabling Submit.
	it("shows a visible error and keeps the draft when onOpenThread rejects", async () => {
		const onOpenThread = vi.fn().mockRejectedValue(new Error("EACCES"));
		const editor = createEditor();
		act(() => {
			root.render(<Harness editor={editor} onOpenThread={onOpenThread} />);
		});
		act(() => {
			editor.commands.setTextSelection({ from: 1, to: 6 });
		});
		act(() => {
			container
				.querySelector<HTMLButtonElement>("[data-comment-composer-trigger]")
				?.click();
		});
		const nativeValueSetter = Object.getOwnPropertyDescriptor(
			window.HTMLTextAreaElement.prototype,
			"value",
		)?.set;
		act(() => {
			const textarea = container.querySelector<HTMLTextAreaElement>(
				"[data-comment-composer-textarea]",
			);
			nativeValueSetter?.call(textarea, "why bold?");
			textarea?.dispatchEvent(new Event("input", { bubbles: true }));
		});

		await act(async () => {
			container
				.querySelector<HTMLButtonElement>("[data-comment-composer-submit]")
				?.click();
		});

		expect(
			container.querySelector("[data-comment-composer-error]")?.textContent,
		).toContain("EACCES");
		// The compose box stays open with the draft intact so the user can retry.
		expect(container.querySelector("[data-comment-composer]")).not.toBeNull();
		expect(
			container.querySelector<HTMLTextAreaElement>(
				"[data-comment-composer-textarea]",
			)?.value,
		).toBe("why bold?");
		expect(
			container.querySelector<HTMLButtonElement>("[data-comment-composer-submit]")
				?.disabled,
		).toBe(false);
	});

	it("opens the panel once a new thread is created from the composer", async () => {
		const onOpenThread = vi.fn().mockResolvedValue(undefined);
		const onPanelOpenChange = vi.fn();
		const editor = createEditor();
		act(() => {
			root.render(
				<Harness
					editor={editor}
					onOpenThread={onOpenThread}
					onPanelOpenChange={onPanelOpenChange}
				/>,
			);
		});
		act(() => {
			editor.commands.setTextSelection({ from: 1, to: 6 });
		});
		act(() => {
			container
				.querySelector<HTMLButtonElement>("[data-comment-composer-trigger]")
				?.click();
		});

		const nativeValueSetter = Object.getOwnPropertyDescriptor(
			window.HTMLTextAreaElement.prototype,
			"value",
		)?.set;
		act(() => {
			const textarea = container.querySelector<HTMLTextAreaElement>(
				"[data-comment-composer-textarea]",
			);
			nativeValueSetter?.call(textarea, "why bold?");
			textarea?.dispatchEvent(new Event("input", { bubbles: true }));
		});

		expect(onPanelOpenChange).not.toHaveBeenCalled();

		await act(async () => {
			container
				.querySelector<HTMLButtonElement>("[data-comment-composer-submit]")
				?.click();
		});

		expect(onPanelOpenChange).toHaveBeenCalledWith(true);
	});

	it("positions the trigger relative to the scrolled viewport, not the unscrolled one", () => {
		const editor = createEditor();
		vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({
			top: 10,
			bottom: 20,
			left: 5,
			right: 5,
		});

		act(() => {
			root.render(<Harness editor={editor} onOpenThread={vi.fn()} />);
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

		const trigger = container.querySelector<HTMLButtonElement>(
			"[data-comment-composer-trigger]",
		);
		expect(trigger?.style.top).toBe("-40px");
		expect(trigger?.style.left).toBe("-30px");

		Object.defineProperty(viewport, "scrollTop", { value: 90 });
		act(() => {
			viewport.dispatchEvent(new Event("scroll"));
		});

		expect(
			container.querySelector<HTMLButtonElement>("[data-comment-composer-trigger]")
				?.style.top,
		).toBe("10px");
	});
});
