import type { Editor } from "@tiptap/core";
import { type RefObject, useEffect, useState } from "react";
import MingcuteMessage3Line from "~icons/mingcute/message-3-line";
import "./CommentParagraphMarker.css";
import type { ResolvedThread } from "./useCommentThreads.js";

type Marker = {
	blockPos: number;
	top: number;
	left: number;
	threadIds: string[];
	allResolved: boolean;
};

/**
 * One marker per textblock (paragraph/heading/list item/etc.) that has at
 * least one anchored comment, placed at the block's trailing edge --
 * positioned outside the editable content flow via `coordsAtPos`, same
 * technique as `CommentGutter`. Unlike the gutter rail (one marker per
 * thread, R17), this groups every thread anchored in the same textblock into
 * one marker with a count badge -- a deliberate divergence scoped to this
 * marker family only, see charter addendum. Clicking jumps to the first
 * thread in that block, in `threads` array order (no timestamp field exists
 * to sort by "oldest").
 */
export function CommentParagraphMarker({
	editor,
	containerRef,
	threads,
	onSelectThread,
}: {
	editor: Editor | null;
	containerRef: RefObject<HTMLElement | null>;
	threads: ResolvedThread[];
	onSelectThread: (threadId: string) => void;
}) {
	const [markers, setMarkers] = useState<Marker[]>([]);

	useEffect(() => {
		const container = containerRef.current;
		if (!editor || !container) {
			setMarkers([]);
			return;
		}

		const update = () => {
			const containerRect = container.getBoundingClientRect();
			const groups = new Map<number, ResolvedThread[]>();
			for (const thread of threads) {
				if (thread.anchorResolution.status === "orphaned") continue;
				const range = thread.anchorResolution.range;
				if (!range) continue;
				let blockPos: number;
				try {
					const $from = editor.state.doc.resolve(range.from);
					blockPos = $from.before($from.depth);
				} catch {
					continue;
				}
				const existing = groups.get(blockPos);
				if (existing) existing.push(thread);
				else groups.set(blockPos, [thread]);
			}

			const next: Marker[] = [];
			for (const [blockPos, group] of groups) {
				const node = editor.state.doc.nodeAt(blockPos);
				if (!node) continue;
				try {
					// Position just before the block's own closing token -- the
					// visual "end of paragraph" spot, same nodeAt+nodeSize idiom
					// used to locate a node's content boundary.
					const blockEnd = blockPos + node.nodeSize - 1;
					const coords = editor.view.coordsAtPos(blockEnd);
					next.push({
						blockPos,
						top: coords.top - containerRect.top,
						left: coords.left - containerRect.left,
						threadIds: group.map((thread) => thread.id),
						allResolved: group.every((thread) => thread.state === "resolved"),
					});
				} catch {
					// Position no longer valid against the live doc -- skip this marker
					// rather than crash the whole overlay.
				}
			}
			setMarkers(next);
		};

		update();
		// "transaction" (not "update") -- external reloads apply via
		// setContent(doc, { emitUpdate: false }), which still dispatches a
		// transaction, so markers must re-resolve there too.
		editor.on("transaction", update);
		return () => {
			editor.off("transaction", update);
		};
	}, [editor, containerRef, threads]);

	if (markers.length === 0) return null;

	return (
		<div className="commentParagraphMarkers" aria-hidden="true">
			{markers.map((marker) => (
				<button
					key={marker.blockPos}
					type="button"
					className="commentParagraphMarker"
					data-comment-paragraph-marker
					data-thread-id={marker.threadIds[0]}
					data-resolved={marker.allResolved}
					style={{
						insetBlockStart: `${marker.top}px`,
						insetInlineStart: `${marker.left}px`,
					}}
					aria-label="Open comment thread"
					onClick={() => onSelectThread(marker.threadIds[0] as string)}
				>
					<MingcuteMessage3Line aria-hidden="true" />
					{marker.threadIds.length > 1 ? (
						<span className="commentParagraphMarkerCount" data-comment-count>
							{marker.threadIds.length}
						</span>
					) : null}
				</button>
			))}
		</div>
	);
}
