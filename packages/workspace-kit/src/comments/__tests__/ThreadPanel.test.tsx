// @vitest-environment happy-dom

import { act, useState } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadPanel } from "../ThreadPanel";
import type { CommentAuthor } from "../types";
import type { ResolvedThread } from "../useCommentThreads";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const AUTHOR: CommentAuthor = { kind: "human", id: "u1" };

function makeThread(overrides: Partial<ResolvedThread> = {}): ResolvedThread {
	return {
		id: "thread-1",
		opener: {
			id: "thread-1",
			by: AUTHOR,
			anchor: { from: 0, to: 5, quote: "Hello", mode: "quote" },
			text: "why bold?",
		},
		events: [],
		state: "open",
		anchorResolution: {
			status: "anchored",
			range: { from: 1, to: 6 },
			method: "revision-replay",
		},
		...overrides,
	};
}

// Simulates the real host contract: ThreadPanel doesn't own the store, so
// re-enabling reply after Reopen comes from the host feeding back an updated
// `threads` array once its own onReopen handler completes (D8).
function ReopenHarness({
	initialThreads,
	onReopenSpy,
}: {
	initialThreads: ResolvedThread[];
	onReopenSpy: (threadId: string) => void;
}) {
	const [threads, setThreads] = useState(initialThreads);
	return (
		<ThreadPanel
			threads={threads}
			currentAuthor={AUTHOR}
			open
			onOpenChange={() => {}}
			onReply={vi.fn().mockResolvedValue(undefined)}
			onResolve={vi.fn().mockResolvedValue(undefined)}
			onReopen={async (threadId) => {
				onReopenSpy(threadId);
				setThreads((prev) =>
					prev.map((thread) =>
						thread.id === threadId ? { ...thread, state: "open" } : thread,
					),
				);
			}}
		/>
	);
}

describe("ThreadPanel", () => {
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

	// D8: the single most charter-load-bearing behavior in this slice.
	it("disables the reply textarea on a resolved thread and re-enables it once Reopen is clicked", async () => {
		const onReopenSpy = vi.fn();
		act(() => {
			root.render(
				<ReopenHarness
					initialThreads={[makeThread({ state: "resolved" })]}
					onReopenSpy={onReopenSpy}
				/>,
			);
		});

		const textareaBefore = document.querySelector<HTMLTextAreaElement>(
			"[data-reply-textarea]",
		);
		expect(textareaBefore).not.toBeNull();
		expect(textareaBefore?.disabled).toBe(true);
		expect(document.querySelector("[data-reply-button]")).toBeNull();

		const reopenButton = document.querySelector<HTMLButtonElement>(
			"[data-reopen-button]",
		);
		expect(reopenButton).not.toBeNull();

		await act(async () => {
			reopenButton?.click();
		});

		expect(onReopenSpy).toHaveBeenCalledWith("thread-1");
		const textareaAfter = document.querySelector<HTMLTextAreaElement>(
			"[data-reply-textarea]",
		);
		expect(textareaAfter?.disabled).toBe(false);
	});

	// R13: a failed write on any of the three in-panel actions must surface
	// visibly, not fail silently.
	it("shows a visible error when a reply fails, and clears it on retry", async () => {
		const onReply = vi.fn().mockRejectedValue(new Error("disk full"));
		act(() => {
			root.render(
				<ThreadPanel
					threads={[makeThread()]}
					currentAuthor={AUTHOR}
					open
					onOpenChange={() => {}}
					onReply={onReply}
					onResolve={vi.fn()}
					onReopen={vi.fn()}
				/>,
			);
		});

		const textarea = document.querySelector<HTMLTextAreaElement>(
			"[data-reply-textarea]",
		);
		const nativeValueSetter = Object.getOwnPropertyDescriptor(
			window.HTMLTextAreaElement.prototype,
			"value",
		)?.set;
		act(() => {
			nativeValueSetter?.call(textarea, "why bold?");
			textarea?.dispatchEvent(new Event("input", { bubbles: true }));
		});

		await act(async () => {
			document.querySelector<HTMLButtonElement>("[data-reply-button]")?.click();
		});

		expect(
			document.querySelector("[data-thread-action-error]")?.textContent,
		).toContain("disk full");

		act(() => {
			nativeValueSetter?.call(textarea, "why bold? v2");
			textarea?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(document.querySelector("[data-thread-action-error]")).toBeNull();
	});

	it("shows a visible error when Resolve fails", async () => {
		const onResolve = vi.fn().mockRejectedValue(new Error("EACCES"));
		act(() => {
			root.render(
				<ThreadPanel
					threads={[makeThread()]}
					currentAuthor={AUTHOR}
					open
					onOpenChange={() => {}}
					onReply={vi.fn()}
					onResolve={onResolve}
					onReopen={vi.fn()}
				/>,
			);
		});

		await act(async () => {
			document.querySelector<HTMLButtonElement>("[data-resolve-button]")?.click();
		});

		expect(
			document.querySelector("[data-thread-action-error]")?.textContent,
		).toContain("EACCES");
	});

	it("shows a visible error when Reopen fails", async () => {
		const onReopen = vi.fn().mockRejectedValue(new Error("EACCES"));
		act(() => {
			root.render(
				<ThreadPanel
					threads={[makeThread({ state: "resolved" })]}
					currentAuthor={AUTHOR}
					open
					onOpenChange={() => {}}
					onReply={vi.fn()}
					onResolve={vi.fn()}
					onReopen={onReopen}
				/>,
			);
		});

		await act(async () => {
			document.querySelector<HTMLButtonElement>("[data-reopen-button]")?.click();
		});

		expect(
			document.querySelector("[data-thread-action-error]")?.textContent,
		).toContain("EACCES");
	});

	it("calls onJumpToThread when the thread body is clicked, but not when the reply controls are clicked", async () => {
		const onJumpToThread = vi.fn();
		act(() => {
			root.render(
				<ThreadPanel
					threads={[makeThread()]}
					currentAuthor={AUTHOR}
					open
					onOpenChange={() => {}}
					onReply={vi.fn().mockResolvedValue(undefined)}
					onResolve={vi.fn().mockResolvedValue(undefined)}
					onReopen={vi.fn()}
					onJumpToThread={onJumpToThread}
				/>,
			);
		});

		act(() => {
			document.querySelector<HTMLElement>("[data-thread-jump-target]")?.click();
		});
		expect(onJumpToThread).toHaveBeenCalledWith("thread-1");

		onJumpToThread.mockClear();
		act(() => {
			document.querySelector<HTMLTextAreaElement>("[data-reply-textarea]")?.click();
		});
		expect(onJumpToThread).not.toHaveBeenCalled();

		// Reply/Resolve are siblings of the jump-target wrapper (open thread).
		onJumpToThread.mockClear();
		act(() => {
			document.querySelector<HTMLButtonElement>("[data-reply-button]")?.click();
		});
		act(() => {
			document.querySelector<HTMLButtonElement>("[data-resolve-button]")?.click();
		});
		expect(onJumpToThread).not.toHaveBeenCalled();
	});

	it("is keyboard-reachable: Enter on the jump target calls onJumpToThread", () => {
		const onJumpToThread = vi.fn();
		act(() => {
			root.render(
				<ThreadPanel
					threads={[makeThread()]}
					currentAuthor={AUTHOR}
					open
					onOpenChange={() => {}}
					onReply={vi.fn()}
					onResolve={vi.fn()}
					onReopen={vi.fn()}
					onJumpToThread={onJumpToThread}
				/>,
			);
		});

		const jumpTarget = document.querySelector<HTMLElement>(
			"[data-thread-jump-target]",
		);
		expect(jumpTarget?.getAttribute("tabIndex")).toBe("0");
		act(() => {
			jumpTarget?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
		});
		expect(onJumpToThread).toHaveBeenCalledWith("thread-1");
	});

	it("is not a tab stop when onJumpToThread is omitted", () => {
		// SidePanel portals to document.body by default (no
		// PortalContainerProvider in this test), so its content never becomes a
		// descendant of the mount container -- query `document` directly, same
		// as every other test in this file.
		const localContainer = document.createElement("div");
		document.body.append(localContainer);
		const localRoot = createRoot(localContainer);
		act(() => {
			localRoot.render(
				<ThreadPanel
					threads={[makeThread()]}
					currentAuthor={AUTHOR}
					open
					onOpenChange={() => {}}
					onReply={vi.fn()}
					onResolve={vi.fn()}
					onReopen={vi.fn()}
				/>,
			);
		});
		expect(
			document
				.querySelector<HTMLElement>("[data-thread-jump-target]")
				?.getAttribute("tabIndex"),
		).toBe("-1");
		act(() => localRoot.unmount());
		localContainer.remove();
	});

	it("does not call onJumpToThread when the Reopen control is clicked on a resolved thread", async () => {
		const onJumpToThread = vi.fn();
		act(() => {
			root.render(
				<ThreadPanel
					threads={[makeThread({ state: "resolved" })]}
					currentAuthor={AUTHOR}
					open
					onOpenChange={() => {}}
					onReply={vi.fn()}
					onResolve={vi.fn()}
					onReopen={vi.fn().mockResolvedValue(undefined)}
					onJumpToThread={onJumpToThread}
				/>,
			);
		});

		await act(async () => {
			document.querySelector<HTMLButtonElement>("[data-reopen-button]")?.click();
		});
		expect(onJumpToThread).not.toHaveBeenCalled();
	});

	it("scrolls the focused thread into view within the panel's own list", () => {
		const threads = [makeThread({ id: "thread-1" }), makeThread({ id: "thread-2" })];
		const renderWith = (focusedThreadId?: string) => {
			act(() => {
				root.render(
					<ThreadPanel
						threads={threads}
						currentAuthor={AUTHOR}
						focusedThreadId={focusedThreadId}
						open
						onOpenChange={() => {}}
						onReply={vi.fn()}
						onResolve={vi.fn()}
						onReopen={vi.fn()}
					/>,
				);
			});
		};

		// Mount first with nothing focused, then patch the already-existing DOM
		// node's own `scrollIntoView` (an instance-level override rather than a
		// prototype patch, since happy-dom's element instances don't reliably
		// pick up a prototype-level stub set up beforehand) before the rerender
		// that focuses it -- this is also the realistic desktop path: the panel
		// is already open, and a second gutter/paragraph marker click changes
		// which thread is focused.
		renderWith(undefined);
		const target = document.querySelector<HTMLElement>(
			'[data-comment-thread-list] [data-thread-id="thread-2"]',
		);
		expect(target).not.toBeNull();
		const scrollIntoView = vi.fn();
		if (target) target.scrollIntoView = scrollIntoView;

		renderWith("thread-2");

		expect(scrollIntoView).toHaveBeenCalledWith(
			expect.objectContaining({ block: "nearest" }),
		);
	});

	it("renders an explicit empty state, never a blank panel", () => {
		expect(() => {
			act(() => {
				root.render(
					<ThreadPanel
						threads={[]}
						currentAuthor={AUTHOR}
						open
						onOpenChange={() => {}}
						onReply={vi.fn()}
						onResolve={vi.fn()}
						onReopen={vi.fn()}
					/>,
				);
			});
		}).not.toThrow();

		expect(document.querySelector("[data-comment-panel-empty]")).not.toBeNull();
		expect(document.querySelector("[data-comment-thread-list]")).toBeNull();
	});

	it("renders a degraded error state instead of the thread list, without throwing", () => {
		expect(() => {
			act(() => {
				root.render(
					<ThreadPanel
						threads={[makeThread()]}
						currentAuthor={AUTHOR}
						open
						onOpenChange={() => {}}
						onReply={vi.fn()}
						onResolve={vi.fn()}
						onReopen={vi.fn()}
						error="Failed to load comments"
					/>,
				);
			});
		}).not.toThrow();

		expect(document.querySelector("[data-comment-panel-error]")?.textContent).toBe(
			"Failed to load comments",
		);
		expect(document.querySelector("[data-comment-thread-list]")).toBeNull();
	});
});
