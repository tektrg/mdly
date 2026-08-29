import type { Editor } from "@tiptap/core";
import { type RefObject, useEffect, useState } from "react";
import { buildQuoteAnchor } from "./buildAnchor.js";
import "./CommentComposer.css";
import type { TextAnchor } from "./types.js";

interface Position {
	from: number;
	to: number;
	top: number;
	left: number;
}

/**
 * Selection-triggered "Comment" affordance: the only UI path that calls
 * `onOpenThread` (marks/gutter/panel in this package only ever render
 * *existing* threads). Anchors are built from the live PM doc's own text
 * (see buildAnchor.ts) rather than the host's flattened-markdown string, so
 * this never blocks on knowing how PM positions line up with that string.
 */
export function CommentComposer({
	editor,
	containerRef,
	onOpenThread,
}: {
	editor: Editor | null;
	containerRef: RefObject<HTMLElement | null>;
	onOpenThread: (anchor: TextAnchor, text: string) => Promise<void>;
}) {
	const [position, setPosition] = useState<Position | null>(null);
	const [composing, setComposing] = useState(false);
	const [draft, setDraft] = useState("");
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		if (!editor) return;
		const update = () => {
			const { from, to } = editor.state.selection;
			const container = containerRef.current;
			if (from === to || !container) {
				setPosition(null);
				setComposing(false);
				return;
			}
			try {
				const coords = editor.view.coordsAtPos(to);
				const containerRect = container.getBoundingClientRect();
				setPosition({
					from,
					to,
					top: coords.bottom - containerRect.top,
					left: coords.left - containerRect.left,
				});
			} catch {
				setPosition(null);
			}
		};
		editor.on("selectionUpdate", update);
		editor.on("update", update);
		return () => {
			editor.off("selectionUpdate", update);
			editor.off("update", update);
		};
	}, [editor, containerRef]);

	if (!editor || !position) return null;

	if (!composing) {
		return (
			<button
				type="button"
				data-comment-composer-trigger
				className="comment-composer-trigger"
				style={{ position: "absolute", top: position.top, left: position.left }}
				onClick={() => setComposing(true)}
			>
				Comment
			</button>
		);
	}

	const submit = () => {
		const text = draft.trim();
		if (!text || submitting) return;
		const anchor = buildQuoteAnchor(editor.state.doc, position.from, position.to);
		setSubmitting(true);
		onOpenThread(anchor, text).then(
			() => {
				setDraft("");
				setComposing(false);
				setSubmitting(false);
			},
			() => {
				setSubmitting(false);
			},
		);
	};

	return (
		<div
			data-comment-composer
			className="comment-composer"
			style={{ position: "absolute", top: position.top, left: position.left }}
		>
			<textarea
				data-comment-composer-textarea
				value={draft}
				disabled={submitting}
				placeholder="Add a comment..."
				onChange={(event) => setDraft(event.target.value)}
			/>
			<div className="comment-composer-actions">
				<button
					type="button"
					data-comment-composer-cancel
					disabled={submitting}
					onClick={() => {
						setComposing(false);
						setDraft("");
					}}
				>
					Cancel
				</button>
				<button
					type="button"
					data-comment-composer-submit
					disabled={submitting || draft.trim().length === 0}
					onClick={submit}
				>
					Comment
				</button>
			</div>
		</div>
	);
}
