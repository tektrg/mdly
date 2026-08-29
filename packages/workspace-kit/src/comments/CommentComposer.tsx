import type { Editor } from "@tiptap/core";
import { type RefObject, useEffect, useState } from "react";
import { buildCommentAnchor } from "./buildAnchor.js";
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
	viewportRef,
	getHeadRevisionId,
	readRevisionContent,
	onOpenThread,
	onPanelOpenChange,
}: {
	editor: Editor | null;
	viewportRef: RefObject<HTMLElement | null>;
	/** Resolves the open doc's current head revision id, so a new comment on unchanged saved text gets D1's `revision` mode instead of always `quote`. Resolves to null when the doc has no saved revision yet. */
	getHeadRevisionId: () => Promise<string | null>;
	readRevisionContent: (revisionId: string) => Promise<string | null>;
	onOpenThread: (anchor: TextAnchor, text: string) => Promise<void>;
	onPanelOpenChange?: (open: boolean) => void;
}) {
	const [position, setPosition] = useState<Position | null>(null);
	const [composing, setComposing] = useState(false);
	const [draft, setDraft] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!editor) return;
		const scrollContainer = viewportRef.current;
		const update = () => {
			const { from, to } = editor.state.selection;
			const container = scrollContainer;
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
					top: coords.bottom - containerRect.top + container.scrollTop,
					left: coords.left - containerRect.left + container.scrollLeft,
				});
			} catch {
				setPosition(null);
			}
		};
		editor.on("selectionUpdate", update);
		editor.on("transaction", update);
		scrollContainer?.addEventListener("scroll", update, { passive: true });
		return () => {
			editor.off("selectionUpdate", update);
			editor.off("transaction", update);
			scrollContainer?.removeEventListener("scroll", update);
		};
	}, [editor, viewportRef]);

	if (!editor || !position) return null;

	if (!composing) {
		return (
			<button
				type="button"
				data-comment-composer-trigger
				className="comment-composer-trigger"
				style={{ position: "absolute", top: position.top, left: position.left }}
				onClick={() => {
					setComposing(true);
					setError(null);
				}}
			>
				Comment
			</button>
		);
	}

	const submit = () => {
		const text = draft.trim();
		if (!text || submitting) return;
		setSubmitting(true);
		setError(null);
		buildCommentAnchor(editor.state.doc, position.from, position.to, {
			getHeadRevisionId,
			readRevisionContent,
		})
			.then((anchor) => onOpenThread(anchor, text))
			.then(
				() => {
					setDraft("");
					setComposing(false);
					setSubmitting(false);
					onPanelOpenChange?.(true);
				},
				(err: unknown) => {
					setSubmitting(false);
					setError(err instanceof Error ? err.message : String(err));
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
				onChange={(event) => {
					setDraft(event.target.value);
					setError(null);
				}}
			/>
			{error ? (
				<p className="comment-composer-error" data-comment-composer-error>
					{error}
				</p>
			) : null}
			<div className="comment-composer-actions">
				<button
					type="button"
					data-comment-composer-cancel
					disabled={submitting}
					onClick={() => {
						setComposing(false);
						setDraft("");
						setError(null);
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
