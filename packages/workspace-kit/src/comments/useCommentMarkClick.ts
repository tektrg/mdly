import type { Editor } from "@tiptap/core";
import { useEffect } from "react";

/**
 * Clicking directly on a highlighted comment span (`.pm-comment-mark`, the
 * inline decoration from `CommentExtension.ts`) is the most direct of the
 * ways into a thread (the others: side panel, rail marker, paragraph
 * marker) -- this focuses that thread via `onSelectThread`, the same
 * function `CommentParagraphMarker`'s own click already uses, so both paths
 * open `ThreadPanel` to the same thread instead of a separate floating view.
 *
 * A non-empty selection at click time means this "click" is really the
 * mouseup of a drag -- e.g. a new selection that starts or ends on an
 * existing mark. That gesture means "start a new comment" (`CommentComposer`'s
 * own trigger already handles it), not "view this one", so it's ignored here
 * rather than also focusing a thread on top of it.
 */
export function useCommentMarkClick(
	editor: Editor | null,
	onSelectThread: (threadId: string) => void,
): void {
	useEffect(() => {
		if (!editor) return;
		const dom = editor.view.dom;
		const handleClick = (event: MouseEvent) => {
			const target = event.target;
			if (!(target instanceof HTMLElement)) return;
			const mark = target.closest<HTMLElement>(".pm-comment-mark");
			if (!mark || !editor.state.selection.empty) return;
			const threadId = mark.getAttribute("data-thread-id");
			if (!threadId) return;
			onSelectThread(threadId);
		};
		dom.addEventListener("click", handleClick);
		return () => {
			dom.removeEventListener("click", handleClick);
		};
	}, [editor, onSelectThread]);
}
