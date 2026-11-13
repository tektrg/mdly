// @vitest-environment happy-dom

import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSubmitShortcut } from "../submitShortcut";
import { ThreadPanel } from "../ThreadPanel";
import type { CommentAuthor, TextAnchor } from "../types";
import type { ResolvedThread } from "../useCommentThreads";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const AUTHOR: CommentAuthor = { kind: "human", id: "u1" };
const ANCHOR: TextAnchor = { from: 0, to: 5, quote: "Hello", mode: "quote" };

function thread(): ResolvedThread {
	return {
		id: "thread-1",
		opener: { id: "thread-1", by: AUTHOR, anchor: ANCHOR, text: "why?" },
		events: [],
		state: "open",
		anchorResolution: {
			status: "anchored",
			range: { from: 1, to: 6 },
			method: "revision-replay",
		},
	};
}

function type(textarea: HTMLTextAreaElement | null, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		window.HTMLTextAreaElement.prototype,
		"value",
	)?.set;
	act(() => {
		setter?.call(textarea, value);
		textarea?.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function keydown(
	target: HTMLElement | null,
	init: KeyboardEventInit,
): KeyboardEvent {
	const event = new KeyboardEvent("keydown", {
		key: "Enter",
		bubbles: true,
		cancelable: true,
		...init,
	});
	target?.dispatchEvent(event);
	return event;
}

describe("isSubmitShortcut", () => {
	it("matches Cmd+Enter and Ctrl+Enter only", () => {
		expect(isSubmitShortcut({ key: "Enter", metaKey: true })).toBe(true);
		expect(isSubmitShortcut({ key: "Enter", ctrlKey: true })).toBe(true);
		expect(isSubmitShortcut({ key: "Enter" })).toBe(false);
		expect(isSubmitShortcut({ key: "Enter", shiftKey: true })).toBe(false);
		expect(isSubmitShortcut({ key: "a", metaKey: true })).toBe(false);
		expect(
			isSubmitShortcut({ key: "Enter", metaKey: true, isComposing: true }),
		).toBe(false);
	});
});

describe("Cmd+Enter in comment textareas", () => {
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

	function renderPanel(extra: Partial<Parameters<typeof ThreadPanel>[0]>) {
		act(() => {
			root.render(
				<ThreadPanel
					threads={[thread()]}
					currentAuthor={AUTHOR}
					open
					onOpenChange={() => {}}
					onReply={vi.fn().mockResolvedValue(undefined)}
					onResolve={vi.fn()}
					onReopen={vi.fn()}
					{...extra}
				/>,
			);
		});
	}

	it("posts a new thread on Cmd+Enter, prevents the newline and stops propagation", async () => {
		const onSubmitNewThread = vi.fn().mockResolvedValue(undefined);
		renderPanel({
			composing: { anchor: ANCHOR, quoteText: "Hello" },
			onSubmitNewThread,
			onCancelCompose: vi.fn(),
		});
		const outer = vi.fn();
		document.addEventListener("keydown", outer);
		const textarea = document.querySelector<HTMLTextAreaElement>(
			"[data-new-thread-textarea]",
		);
		type(textarea, "line one");
		let event: KeyboardEvent | undefined;
		await act(async () => {
			event = keydown(textarea, { metaKey: true });
		});
		document.removeEventListener("keydown", outer);
		expect(onSubmitNewThread).toHaveBeenCalledWith(ANCHOR, "line one");
		expect(event?.defaultPrevented).toBe(true);
		expect(outer).not.toHaveBeenCalled();
	});

	it("posts a reply on Ctrl+Enter", async () => {
		const onReply = vi.fn().mockResolvedValue(undefined);
		renderPanel({ onReply });
		const textarea = document.querySelector<HTMLTextAreaElement>(
			"[data-reply-textarea]",
		);
		type(textarea, "a reply");
		await act(async () => {
			keydown(textarea, { ctrlKey: true });
		});
		expect(onReply).toHaveBeenCalledWith("thread-1", "a reply");
	});

	it("plain Enter does not submit and keeps its default (newline)", async () => {
		const onReply = vi.fn().mockResolvedValue(undefined);
		renderPanel({ onReply });
		const textarea = document.querySelector<HTMLTextAreaElement>(
			"[data-reply-textarea]",
		);
		type(textarea, "a reply");
		let event: KeyboardEvent | undefined;
		await act(async () => {
			event = keydown(textarea, {});
		});
		expect(onReply).not.toHaveBeenCalled();
		expect(event?.defaultPrevented).toBe(false);
	});

	it("Cmd+Enter on an empty draft does nothing", async () => {
		const onReply = vi.fn().mockResolvedValue(undefined);
		renderPanel({ onReply });
		const textarea = document.querySelector<HTMLTextAreaElement>(
			"[data-reply-textarea]",
		);
		await act(async () => {
			keydown(textarea, { metaKey: true });
		});
		expect(onReply).not.toHaveBeenCalled();
	});

	it("submit buttons carry the ⌘↩ hint", () => {
		renderPanel({
			composing: { anchor: ANCHOR, quoteText: "Hello" },
			onSubmitNewThread: vi.fn(),
			onCancelCompose: vi.fn(),
		});
		for (const sel of ["[data-new-thread-submit]", "[data-reply-button]"]) {
			const button = document.querySelector(sel);
			expect(button?.getAttribute("title")).toContain("⌘↩");
			expect(button?.getAttribute("aria-keyshortcuts")).toBe("Meta+Enter");
		}
	});
});
