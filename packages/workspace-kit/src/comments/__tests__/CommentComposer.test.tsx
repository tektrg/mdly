// @vitest-environment happy-dom

import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { act, useRef } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
}: {
	editor: Editor;
	onOpenThread: (anchor: unknown, text: string) => Promise<void>;
	onPanelOpenChange?: (open: boolean) => void;
}) {
	const viewportRef = useRef<HTMLDivElement | null>(null);
	return (
		<div ref={viewportRef}>
			<CommentComposer
				editor={editor}
				viewportRef={viewportRef}
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
