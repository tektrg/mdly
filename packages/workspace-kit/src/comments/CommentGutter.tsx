import type { Editor } from "@tiptap/core";
import { type RefObject, useEffect, useState } from "react";
import "./CommentGutter.css";
import type { ResolvedThread } from "./useCommentThreads.js";

type Marker = { threadId: string; top: number; resolved: boolean };

/**
 * One small marker per non-orphaned thread, positioned outside the
 * scrollable content flow (unlike the ProseMirror decoration in
 * `CommentExtension.ts`, which lives inside it) -- same rail-marker
 * positioning family as `history/DiffChangeRail.tsx`, kept self-contained
 * here rather than imported from `history/`. Two threads on the same or
 * overlapping lines render two distinct markers (R17), never collapsed.
 */
export function CommentGutter({
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
			const containerTop = container.getBoundingClientRect().top;
			const next: Marker[] = [];
			for (const thread of threads) {
				if (thread.anchorResolution.status === "orphaned") continue;
				const range = thread.anchorResolution.range;
				if (!range) continue;
				try {
					const coords = editor.view.coordsAtPos(range.from);
					next.push({
						threadId: thread.id,
						top: coords.top - containerTop,
						resolved: thread.state === "resolved",
					});
				} catch {
					// Position no longer valid against the live doc -- skip this marker
					// rather than crash the whole gutter.
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
		<div className="commentGutter" aria-hidden="true">
			{markers.map((marker) => (
				<button
					key={marker.threadId}
					type="button"
					className="commentGutterMarker"
					data-comment-gutter-marker
					data-thread-id={marker.threadId}
					data-resolved={marker.resolved}
					style={{ insetBlockStart: `${marker.top}px` }}
					aria-label="Open comment thread"
					onClick={() => onSelectThread(marker.threadId)}
				/>
			))}
		</div>
	);
}
