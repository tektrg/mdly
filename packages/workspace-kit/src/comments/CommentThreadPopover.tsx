import type { Editor } from "@tiptap/core";
import { type RefObject, useEffect, useRef, useState } from "react";
import "./CommentThreadPopover.css";
import { ThreadItem } from "./ThreadPanel.js";
import type { ResolvedThread } from "./useCommentThreads.js";

interface Position {
	top: number;
	left: number;
}

/**
 * Clicking directly on a highlighted comment span (`.pm-comment-mark`, the
 * inline decoration from `CommentExtension.ts`) shows that thread right where
 * it was clicked -- the most direct of the four ways into a thread (the
 * others: side panel, rail marker, paragraph marker). Reuses `ThreadItem` so
 * reply/resolve/reopen behave identically here and in the panel.
 *
 * Positioned from the clicked mark's own live bounding rect (not a cached
 * pixel snapshot), recomputed on scroll/transaction so it tracks the text if
 * the document reflows while open; closes itself if that mark's thread is no
 * longer present in `threads` on the next fetch (e.g. deleted server-side --
 * not reachable from anything the desktop app can do today, but this stays
 * correct for any host that adds one later).
 */
export function CommentThreadPopover({
	editor,
	viewportRef,
	threads,
	onReply,
	onResolve,
	onReopen,
}: {
	editor: Editor | null;
	viewportRef: RefObject<HTMLElement | null>;
	threads: ResolvedThread[];
	onReply: (threadId: string, text: string) => Promise<void>;
	onResolve: (threadId: string) => Promise<void>;
	onReopen: (threadId: string) => Promise<void>;
}) {
	const [openThreadId, setOpenThreadId] = useState<string | null>(null);
	const [position, setPosition] = useState<Position | null>(null);
	const markElRef = useRef<HTMLElement | null>(null);
	const popoverRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!editor) return;
		const dom = editor.view.dom;
		const viewport = viewportRef.current;

		const close = () => {
			markElRef.current = null;
			setOpenThreadId(null);
			setPosition(null);
		};

		const reposition = () => {
			const mark = markElRef.current;
			const container = viewportRef.current;
			if (!mark || !container || !dom.contains(mark)) {
				close();
				return;
			}
			const rect = mark.getBoundingClientRect();
			const containerRect = container.getBoundingClientRect();
			setPosition({
				top: rect.bottom - containerRect.top + container.scrollTop,
				left: rect.left - containerRect.left + container.scrollLeft,
			});
		};

		const handleClick = (event: MouseEvent) => {
			const target = event.target;
			if (!(target instanceof HTMLElement)) return;
			const mark = target.closest<HTMLElement>(".pm-comment-mark");
			// A non-empty selection means this "click" is really the mouseup of a
			// drag -- e.g. a new selection that starts or ends on an existing
			// mark. That gesture means "start a new comment" (CommentComposer's
			// own trigger already handles it), not "view this one" -- opening
			// this popover too would show two floating affordances over the same
			// spot at once.
			if (!mark || !editor.state.selection.empty) {
				close();
				return;
			}
			const threadId = mark.getAttribute("data-thread-id");
			if (!threadId) return;
			markElRef.current = mark;
			setOpenThreadId(threadId);
			reposition();
		};

		const handlePointerDownOutside = (event: PointerEvent) => {
			if (!markElRef.current) return;
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (dom.contains(target) || popoverRef.current?.contains(target)) return;
			close();
		};

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && markElRef.current) close();
		};

		dom.addEventListener("click", handleClick);
		// "transaction" (not "update") -- matches CommentGutter/CommentComposer:
		// external reloads apply via setContent(doc, { emitUpdate: false }),
		// which still dispatches a transaction.
		editor.on("transaction", reposition);
		viewport?.addEventListener("scroll", reposition, { passive: true });
		window.addEventListener("pointerdown", handlePointerDownOutside, true);
		window.addEventListener("keydown", handleKeyDown);
		return () => {
			dom.removeEventListener("click", handleClick);
			editor.off("transaction", reposition);
			viewport?.removeEventListener("scroll", reposition);
			window.removeEventListener("pointerdown", handlePointerDownOutside, true);
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, [editor, viewportRef]);

	useEffect(() => {
		if (openThreadId && !threads.some((thread) => thread.id === openThreadId)) {
			markElRef.current = null;
			setOpenThreadId(null);
			setPosition(null);
		}
	}, [threads, openThreadId]);

	if (!openThreadId || !position) return null;
	const thread = threads.find((candidate) => candidate.id === openThreadId);
	if (!thread) return null;

	return (
		<div
			ref={popoverRef}
			className="comment-thread-popover"
			data-comment-thread-popover
			style={{ position: "absolute", top: position.top, left: position.left }}
		>
			<ul className="m-0 list-none p-0">
				<ThreadItem
					thread={thread}
					focused={false}
					onReply={onReply}
					onResolve={onResolve}
					onReopen={onReopen}
				/>
			</ul>
		</div>
	);
}
