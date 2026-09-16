import type { Editor } from "@tiptap/core";
import { type RefObject, useEffect, useState } from "react";
import MingcuteCheckLine from "~icons/mingcute/check-line";
import MingcuteLinkLine from "~icons/mingcute/link-line";
import MingcuteMessage3Line from "~icons/mingcute/message-3-line";
import { MOBILE_MEDIA_QUERY, useMediaQuery } from "../lib/useMediaQuery.js";
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
 * Selection-triggered toolbar: "Comment" (the only UI path that starts a new
 * thread -- marks/gutter/panel in this package only ever render *existing*
 * threads) plus "copy link to selection". Anchors are built from the live PM
 * doc's own text (see buildAnchor.ts) rather than the host's
 * flattened-markdown string, so this never blocks on knowing how PM
 * positions line up with that string.
 *
 * Clicking "Comment" builds the anchor eagerly and hands it to
 * `onStartComposing` -- the actual compose UI (textarea + Post/Cancel) lives
 * in `ThreadPanel` now, not here, so both "start a new comment" and "view/
 * reply to an existing one" open into the same panel instead of two
 * different floating popups.
 */
export function CommentComposer({
	editor,
	viewportRef,
	getHeadRevisionId,
	readRevisionContent,
	onStartComposing,
}: {
	editor: Editor | null;
	viewportRef: RefObject<HTMLElement | null>;
	/** Resolves the open doc's current head revision id, so a new comment on unchanged saved text gets D1's `revision` mode instead of always `quote`. Resolves to null when the doc has no saved revision yet. */
	getHeadRevisionId: () => Promise<string | null>;
	readRevisionContent: (revisionId: string) => Promise<string | null>;
	onStartComposing: (
		anchor: TextAnchor,
		quoteText: string,
		range: { from: number; to: number },
	) => void;
}) {
	const [position, setPosition] = useState<Position | null>(null);
	const [building, setBuilding] = useState(false);
	const [copied, setCopied] = useState(false);
	const [copyError, setCopyError] = useState<string | null>(null);
	// Below `md` this toolbar keeps the same absolutely-positioned layout as
	// desktop, just with touch-sized buttons -- no more full-width docked bar.
	const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);

	useEffect(() => {
		if (!editor) return;
		const scrollContainer = viewportRef.current;
		const update = () => {
			const { from, to } = editor.state.selection;
			const container = scrollContainer;
			if (from === to || !container) {
				setPosition(null);
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

	const handleStartComposing = () => {
		if (building) return;
		setBuilding(true);
		buildCommentAnchor(editor.state.doc, position.from, position.to, {
			getHeadRevisionId,
			readRevisionContent,
		}).then((anchor) => {
			setBuilding(false);
			onStartComposing(anchor, anchor.quote, {
				from: position.from,
				to: position.to,
			});
		});
	};

	// Selected text for the copy-link action. Trimmed to the first words so
	// the text-fragment URL stays short; falls back to plain-text copy.
	const selectedText = editor.state.doc
		.textBetween(position.from, position.to, " ")
		.replace(/\s+/g, " ")
		.trim();

	const copyLink = () => {
		const fragment = selectedText.split(" ").slice(0, 12).join(" ");
		const base = window.location.href.split("#")[0];
		const link = fragment
			? `${base}#:~:text=${encodeURIComponent(fragment)}`
			: base;
		setCopyError(null);
		navigator.clipboard.writeText(link).then(
			() => {
				setCopied(true);
				window.setTimeout(() => setCopied(false), 1500);
			},
			() => {
				// Clipboard API can reject in insecure contexts — still copy
				// the raw selection so the gesture never silently does nothing.
				if (selectedText) {
					navigator.clipboard.writeText(selectedText).then(
						() => {
							setCopied(true);
							window.setTimeout(() => setCopied(false), 1500);
						},
						() => setCopyError("Copy failed"),
					);
				} else {
					setCopyError("Copy failed");
				}
			},
		);
	};

	return (
		<div
			data-comment-selection-toolbar
			className={
				isMobile
					? "comment-selection-toolbar comment-selection-toolbar--mobile"
					: "comment-selection-toolbar"
			}
			style={{ position: "absolute", top: position.top, left: position.left }}
		>
			<button
				type="button"
				data-comment-composer-trigger
				className="comment-composer-trigger"
				aria-label="Comment"
				title="Comment"
				disabled={building}
				onClick={handleStartComposing}
			>
				<MingcuteMessage3Line aria-hidden="true" />
			</button>
			<button
				type="button"
				data-comment-copy-link
				className="comment-composer-trigger"
				aria-label="Copy link to selection"
				title={copied ? "Copied" : "Copy link to selection"}
				onClick={copyLink}
			>
				{copied ? (
					<MingcuteCheckLine aria-hidden="true" />
				) : (
					<MingcuteLinkLine aria-hidden="true" />
				)}
			</button>
			{copyError ? (
				<p className="comment-composer-error" data-comment-copy-error>
					{copyError}
				</p>
			) : null}
		</div>
	);
}
