import type { Editor } from "@tiptap/core";
import { type RefObject, useEffect, useRef, useState } from "react";
import MingcuteCheckLine from "~icons/mingcute/check-line";
import MingcuteLinkLine from "~icons/mingcute/link-line";
import MingcuteMessage3Line from "~icons/mingcute/message-3-line";
import { useKeyboardOffset } from "../lib/useKeyboardOffset.js";
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
	const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);

	useEffect(() => {
		if (composing) composerTextareaRef.current?.focus();
	}, [composing]);
	const [copied, setCopied] = useState(false);
	const [copyError, setCopyError] = useState<string | null>(null);
	// Below `md` the inline popup is replaced by a bar docked above the soft
	// keyboard (R6). Desktop keeps the exact inline behavior below.
	const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
	const keyboardOffset = useKeyboardOffset(isMobile && position !== null);

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

	if (isMobile) {
		return (
			<div
				data-comment-selection-bar
				className="fixed inset-inline-0 z-30 border-t border-border bg-popover/95 backdrop-blur-md"
				style={{
					bottom: keyboardOffset,
					paddingBlockEnd: "max(env(safe-area-inset-bottom), 0.5rem)",
				}}
			>
				{!composing ? (
					<div className="flex items-center gap-2 px-4 pt-2">
						<button
							type="button"
							data-comment-composer-trigger
							className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground"
							aria-label="Comment"
							onClick={() => {
								setComposing(true);
								setError(null);
							}}
						>
							<MingcuteMessage3Line aria-hidden="true" className="size-4" />
							Comment
						</button>
						<button
							type="button"
							data-comment-copy-link
							className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full border border-border bg-secondary px-4 text-sm font-medium text-secondary-foreground"
							aria-label="Copy link to selection"
							onClick={copyLink}
						>
							{copied ? (
								<MingcuteCheckLine aria-hidden="true" className="size-4" />
							) : (
								<MingcuteLinkLine aria-hidden="true" className="size-4" />
							)}
							{copied ? "Copied" : "Copy link"}
						</button>
					</div>
				) : (
					<div data-comment-composer className="flex flex-col gap-2 px-4 pt-2">
						<textarea
							data-comment-composer-textarea
							value={draft}
							disabled={submitting}
							placeholder="Add a comment..."
							rows={3}
							className="max-h-36 w-full resize-none rounded-sm border border-input bg-card px-2 py-1.5 text-base outline-hidden focus-visible:border-ring"
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
				)}
				{copyError && !composing ? (
					<p
						className="comment-composer-error px-4 pt-1"
						data-comment-copy-error
					>
						{copyError}
					</p>
				) : null}
			</div>
		);
	}

	if (!composing) {
		return (
			<button
				type="button"
				data-comment-composer-trigger
				className="comment-composer-trigger"
				style={{ position: "absolute", top: position.top, left: position.left }}
				aria-label="Comment"
				title="Comment"
				onClick={() => {
					setComposing(true);
					setError(null);
				}}
			>
				<MingcuteMessage3Line aria-hidden="true" />
			</button>
		);
	}

	return (
		<div
			data-comment-composer
			className="comment-composer"
			style={{ position: "absolute", top: position.top, left: position.left }}
		>
			<textarea
				ref={composerTextareaRef}
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
