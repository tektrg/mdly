// @vitest-environment happy-dom

import { act, useState } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadPanel } from "../ThreadPanel";
import type { CommentAuthor, TextAnchor } from "../types";
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
			onDelete={vi.fn().mockResolvedValue(undefined)}
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
					onDelete={vi.fn()}
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
					onDelete={vi.fn()}
				/>,
			);
		});

		await act(async () => {
			document
				.querySelector<HTMLButtonElement>("[data-resolve-button]")
				?.click();
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
					onDelete={vi.fn()}
				/>,
			);
		});

		await act(async () => {
			document
				.querySelector<HTMLButtonElement>("[data-reopen-button]")
				?.click();
		});

		expect(
			document.querySelector("[data-thread-action-error]")?.textContent,
		).toContain("EACCES");
	});

	it("asks inline before deleting: Delete reveals Confirm/Cancel, Confirm calls onDelete", async () => {
		const onDelete = vi.fn().mockResolvedValue(undefined);
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
					onDelete={onDelete}
				/>,
			);
		});

		expect(
			document.querySelector<HTMLButtonElement>("[data-delete-button]"),
		).not.toBeNull();
		expect(document.querySelector("[data-confirm-delete-button]")).toBeNull();

		act(() => {
			document
				.querySelector<HTMLButtonElement>("[data-delete-button]")
				?.click();
		});

		// Arming the confirmation must not delete yet.
		expect(onDelete).not.toHaveBeenCalled();
		expect(
			document.querySelector("[data-confirm-delete-button]"),
		).not.toBeNull();
		expect(
			document.querySelector("[data-cancel-delete-button]"),
		).not.toBeNull();

		await act(async () => {
			document
				.querySelector<HTMLButtonElement>("[data-confirm-delete-button]")
				?.click();
		});

		expect(onDelete).toHaveBeenCalledWith("thread-1");
	});

	it("does not call onDelete when the inline confirmation is cancelled", async () => {
		const onDelete = vi.fn().mockResolvedValue(undefined);
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
					onDelete={onDelete}
				/>,
			);
		});

		act(() => {
			document
				.querySelector<HTMLButtonElement>("[data-delete-button]")
				?.click();
		});
		act(() => {
			document
				.querySelector<HTMLButtonElement>("[data-cancel-delete-button]")
				?.click();
		});

		expect(onDelete).not.toHaveBeenCalled();
		expect(
			document.querySelector<HTMLButtonElement>("[data-delete-button]"),
		).not.toBeNull();
		expect(document.querySelector("[data-confirm-delete-button]")).toBeNull();
	});

	it("shows Delete on a resolved thread and deletes through the same inline confirmation", async () => {
		const onDelete = vi.fn().mockResolvedValue(undefined);
		act(() => {
			root.render(
				<ThreadPanel
					threads={[makeThread({ state: "resolved" })]}
					currentAuthor={AUTHOR}
					open
					onOpenChange={() => {}}
					onReply={vi.fn()}
					onResolve={vi.fn()}
					onReopen={vi.fn()}
					onDelete={onDelete}
				/>,
			);
		});

		expect(
			document.querySelector<HTMLButtonElement>("[data-delete-button]"),
		).not.toBeNull();

		act(() => {
			document
				.querySelector<HTMLButtonElement>("[data-delete-button]")
				?.click();
		});
		await act(async () => {
			document
				.querySelector<HTMLButtonElement>("[data-confirm-delete-button]")
				?.click();
		});

		expect(onDelete).toHaveBeenCalledWith("thread-1");
	});

	it("shows a visible error when Delete fails", async () => {
		const onDelete = vi.fn().mockRejectedValue(new Error("EACCES"));
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
					onDelete={onDelete}
				/>,
			);
		});

		act(() => {
			document
				.querySelector<HTMLButtonElement>("[data-delete-button]")
				?.click();
		});
		await act(async () => {
			document
				.querySelector<HTMLButtonElement>("[data-confirm-delete-button]")
				?.click();
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
					onDelete={vi.fn()}
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
			document
				.querySelector<HTMLTextAreaElement>("[data-reply-textarea]")
				?.click();
		});
		expect(onJumpToThread).not.toHaveBeenCalled();

		// Reply/Resolve are siblings of the jump-target wrapper (open thread).
		onJumpToThread.mockClear();
		act(() => {
			document.querySelector<HTMLButtonElement>("[data-reply-button]")?.click();
		});
		act(() => {
			document
				.querySelector<HTMLButtonElement>("[data-resolve-button]")
				?.click();
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
					onDelete={vi.fn()}
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
					onDelete={vi.fn()}
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
					onDelete={vi.fn()}
					onJumpToThread={onJumpToThread}
				/>,
			);
		});

		await act(async () => {
			document
				.querySelector<HTMLButtonElement>("[data-reopen-button]")
				?.click();
		});
		expect(onJumpToThread).not.toHaveBeenCalled();
	});

	it("scrolls the focused thread into view within the panel's own list", () => {
		const threads = [
			makeThread({ id: "thread-1" }),
			makeThread({ id: "thread-2" }),
		];
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
						onDelete={vi.fn()}
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
						onDelete={vi.fn()}
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
						onDelete={vi.fn()}
						error="Failed to load comments"
					/>,
				);
			});
		}).not.toThrow();

		expect(
			document.querySelector("[data-comment-panel-error]")?.textContent,
		).toBe("Failed to load comments");
		expect(document.querySelector("[data-comment-thread-list]")).toBeNull();
	});

	const COMPOSING_ANCHOR: TextAnchor = {
		from: 0,
		to: 5,
		quote: "Hello",
		mode: "quote",
	};

	describe("composing a new thread", () => {
		it("renders the composer pinned above the thread list when composing is set", () => {
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
						onDelete={vi.fn()}
						composing={{ anchor: COMPOSING_ANCHOR, quoteText: "Hello" }}
						onSubmitNewThread={vi.fn().mockResolvedValue(undefined)}
						onCancelCompose={vi.fn()}
					/>,
				);
			});

			const composer = document.querySelector("[data-new-thread-composer]");
			expect(composer).not.toBeNull();
			expect(composer?.textContent).toContain("Hello");
			expect(document.querySelector("[data-comment-thread]")).not.toBeNull();
		});

		it("auto-opens the panel when composing becomes non-null", () => {
			function Harness({ composing }: { composing: boolean }) {
				return (
					<ThreadPanel
						threads={[]}
						currentAuthor={AUTHOR}
						onReply={vi.fn()}
						onResolve={vi.fn()}
						onReopen={vi.fn()}
						onDelete={vi.fn()}
						composing={
							composing
								? { anchor: COMPOSING_ANCHOR, quoteText: "Hello" }
								: null
						}
						onSubmitNewThread={vi.fn().mockResolvedValue(undefined)}
						onCancelCompose={vi.fn()}
					/>
				);
			}

			act(() => {
				root.render(<Harness composing={false} />);
			});
			expect(document.querySelector("[data-new-thread-composer]")).toBeNull();

			act(() => {
				root.render(<Harness composing={true} />);
			});
			expect(
				document.querySelector("[data-new-thread-composer]"),
			).not.toBeNull();
		});

		// Regression guard: the "auto-open on composing" effect above is keyed
		// on the `composing` prop's own identity (`[composing]` deps), by
		// design -- so a HOST that reconstructs a fresh `{ anchor, quoteText }`
		// object every render (instead of passing a stable state reference)
		// would re-fire this effect, and force the panel back open, on every
		// unrelated re-render while composing -- fighting a user who just
		// closed it via the panel's own Close/Escape. A stable reference must
		// not re-trigger the open call once the host has since closed it.
		it("does not force the panel back open on a re-render with the same composing reference, once the host has closed it", () => {
			const onOpenChange = vi.fn();
			const composing = { anchor: COMPOSING_ANCHOR, quoteText: "Hello" };
			function Harness({ open }: { open: boolean }) {
				return (
					<ThreadPanel
						threads={[]}
						currentAuthor={AUTHOR}
						open={open}
						onOpenChange={onOpenChange}
						onReply={vi.fn()}
						onResolve={vi.fn()}
						onReopen={vi.fn()}
						onDelete={vi.fn()}
						composing={composing}
						onSubmitNewThread={vi.fn().mockResolvedValue(undefined)}
						onCancelCompose={vi.fn()}
					/>
				);
			}

			act(() => {
				root.render(<Harness open={true} />);
			});
			expect(onOpenChange).toHaveBeenCalledTimes(1);
			expect(onOpenChange).toHaveBeenLastCalledWith(true);

			// The host closes the panel (e.g. its own Close button/Escape
			// handling flipped its `open` state) -- an unrelated re-render with
			// the exact same `composing` reference must not call onOpenChange
			// again, or the panel could never actually stay closed.
			act(() => {
				root.render(<Harness open={false} />);
			});
			expect(onOpenChange).toHaveBeenCalledTimes(1);
		});

		it("submits the draft with the composing anchor and clears on success", async () => {
			const onSubmitNewThread = vi.fn().mockResolvedValue(undefined);
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
						onDelete={vi.fn()}
						composing={{ anchor: COMPOSING_ANCHOR, quoteText: "Hello" }}
						onSubmitNewThread={onSubmitNewThread}
						onCancelCompose={vi.fn()}
					/>,
				);
			});

			const textarea = document.querySelector<HTMLTextAreaElement>(
				"[data-new-thread-textarea]",
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
				document
					.querySelector<HTMLButtonElement>("[data-new-thread-submit]")
					?.click();
			});

			expect(onSubmitNewThread).toHaveBeenCalledWith(
				COMPOSING_ANCHOR,
				"why bold?",
			);
		});

		it("calls onCancelCompose when Cancel is clicked", () => {
			const onCancelCompose = vi.fn();
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
						onDelete={vi.fn()}
						composing={{ anchor: COMPOSING_ANCHOR, quoteText: "Hello" }}
						onSubmitNewThread={vi.fn().mockResolvedValue(undefined)}
						onCancelCompose={onCancelCompose}
					/>,
				);
			});

			act(() => {
				document
					.querySelector<HTMLButtonElement>("[data-new-thread-cancel]")
					?.click();
			});

			expect(onCancelCompose).toHaveBeenCalledTimes(1);
		});

		it("shows a visible error and keeps the draft when onSubmitNewThread rejects", async () => {
			const onSubmitNewThread = vi.fn().mockRejectedValue(new Error("EACCES"));
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
						onDelete={vi.fn()}
						composing={{ anchor: COMPOSING_ANCHOR, quoteText: "Hello" }}
						onSubmitNewThread={onSubmitNewThread}
						onCancelCompose={vi.fn()}
					/>,
				);
			});

			const textarea = document.querySelector<HTMLTextAreaElement>(
				"[data-new-thread-textarea]",
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
				document
					.querySelector<HTMLButtonElement>("[data-new-thread-submit]")
					?.click();
			});

			expect(
				document.querySelector("[data-new-thread-error]")?.textContent,
			).toContain("EACCES");
			expect(
				document.querySelector<HTMLTextAreaElement>(
					"[data-new-thread-textarea]",
				)?.value,
			).toBe("why bold?");
		});
	});

	// QA finding #4: `ThreadPanel` renders as a `SidePanel` (desktop) or a
	// `BottomSheet` (mobile) depending on `useMediaQuery`, and the two wrap
	// their children in different Dialog trees -- crossing that breakpoint
	// unmounts and remounts `NewThreadComposer`. Before the fix, the draft
	// text lived in that component's own local state, so a resize mid-draft
	// silently wiped whatever had been typed while the panel stayed in
	// "composing" mode. `ThreadPanel` itself does not remount on this switch
	// (only its returned JSX subtree does), so lifting the draft up to it is
	// what makes the text survive.
	describe("draft survives a mobile/desktop breakpoint change while composing (QA finding #4)", () => {
		let originalMatchMedia: typeof window.matchMedia | undefined;

		beforeEach(() => {
			originalMatchMedia = window.matchMedia;
		});

		afterEach(() => {
			// `useMediaQuery` treats a missing `matchMedia` the same as one set
			// back to `undefined` (both fail its `typeof ... !== "undefined"`
			// guard), so this restores happy-dom's original either way without
			// needing `delete`.
			window.matchMedia = originalMatchMedia as typeof window.matchMedia;
		});

		function mockMatchMedia(initialMatches: boolean) {
			let matches = initialMatches;
			const listeners = new Set<(event: { matches: boolean }) => void>();
			const mql = {
				get matches() {
					return matches;
				},
				media: "",
				addEventListener: (
					_type: string,
					cb: (event: { matches: boolean }) => void,
				) => listeners.add(cb),
				removeEventListener: (
					_type: string,
					cb: (event: { matches: boolean }) => void,
				) => listeners.delete(cb),
				addListener: () => {},
				removeListener: () => {},
				dispatchEvent: () => true,
			};
			window.matchMedia = vi
				.fn()
				.mockReturnValue(mql) as unknown as typeof window.matchMedia;
			return {
				setMatches(next: boolean) {
					matches = next;
					for (const cb of listeners) cb({ matches: next });
				},
			};
		}

		it("keeps the typed draft text when the panel switches between SidePanel and BottomSheet mid-draft", () => {
			const { setMatches } = mockMatchMedia(false);
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
						onDelete={vi.fn()}
						composing={{ anchor: COMPOSING_ANCHOR, quoteText: "Hello" }}
						onSubmitNewThread={vi.fn().mockResolvedValue(undefined)}
						onCancelCompose={vi.fn()}
					/>,
				);
			});

			const nativeValueSetter = Object.getOwnPropertyDescriptor(
				window.HTMLTextAreaElement.prototype,
				"value",
			)?.set;
			act(() => {
				nativeValueSetter?.call(
					document.querySelector("[data-new-thread-textarea]"),
					"half-typed dra",
				);
				document
					.querySelector("[data-new-thread-textarea]")
					?.dispatchEvent(new Event("input", { bubbles: true }));
			});
			expect(
				document.querySelector<HTMLTextAreaElement>(
					"[data-new-thread-textarea]",
				)?.value,
			).toBe("half-typed dra");

			// Cross into mobile width -- the panel swaps SidePanel for
			// BottomSheet, remounting the composer underneath it.
			act(() => {
				setMatches(true);
			});

			expect(
				document.querySelector<HTMLTextAreaElement>(
					"[data-new-thread-textarea]",
				)?.value,
			).toBe("half-typed dra");
		});
	});

	describe("Markdown rendering of comment text", () => {
		it("renders **bold** in the opener text as a <strong>, not literal asterisks", () => {
			act(() => {
				root.render(
					<ThreadPanel
						threads={[
							makeThread({
								opener: { ...makeThread().opener, text: "why **bold**?" },
							}),
						]}
						currentAuthor={AUTHOR}
						open
						onOpenChange={() => {}}
						onReply={vi.fn()}
						onResolve={vi.fn()}
						onReopen={vi.fn()}
						onDelete={vi.fn()}
					/>,
				);
			});

			const logText = document.querySelector("[data-comment-log-text]");
			expect(logText?.querySelector("strong")?.textContent).toBe("bold");
			expect(logText?.textContent).not.toContain("**");
		});
	});
});
