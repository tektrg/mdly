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
