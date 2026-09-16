import { useEffect, useRef, useState } from "react";
import { MOBILE_MEDIA_QUERY, useMediaQuery } from "../lib/useMediaQuery.js";
import { BottomSheet } from "../primitives/bottomSheet.js";
import { Button } from "../primitives/button.js";
import { SidePanel } from "../primitives/sidePanel.js";
import { CommentMarkdown } from "./CommentMarkdown.js";
import type { CommentAuthor, CommentThreadEvent, TextAnchor } from "./types.js";
import type { ResolvedThread } from "./useCommentThreads.js";

function authorLabel(author: CommentAuthor): string {
	return author.label ?? author.id;
}

function eventVerb(kind: CommentThreadEvent["kind"]): string {
	switch (kind) {
		case "thread-opened":
			return "opened";
		case "replied":
			return "replied";
		case "resolved":
			return "resolved";
		case "reopened":
			return "reopened";
		case "deleted":
			return "deleted";
		default:
			return kind;
	}
}

function ThreadLogLine({
	by,
	verb,
	text,
}: {
	by: CommentAuthor;
	verb: string;
	text?: string;
}) {
	return (
		<li className="flex flex-col gap-0.5 text-[12px]" data-comment-log-line>
			<span className="text-muted-foreground">
				{authorLabel(by)} {verb}
			</span>
			{text ? (
				<div data-comment-log-text>
					<CommentMarkdown text={text} />
				</div>
			) : null}
		</li>
	);
}

/**
 * Composer for a brand-new thread, pinned above the thread list while
 * `ThreadPanel`'s `composing` prop is set. Same visual weight as `ThreadItem`'s
 * own reply box below. The quote is shown read-only for context -- the
 * document-side highlight for this exact range is a separate decoration
 * (`pm-comment-mark-pending`, set by the wiring layer via
 * `setPendingCommentAnchor`), since the panel has no access to the editor.
 *
 * The draft text itself is *not* local state here (see the `draft`/
 * `onDraftChange` props): `ThreadPanel` swaps between rendering this inside a
 * `SidePanel` or a `BottomSheet` depending on viewport width, and crossing
 * that breakpoint mid-draft unmounts/remounts this whole component (the two
 * wrap children in different underlying Dialog trees) -- local state here
 * would silently wipe whatever the user had typed. Lifting the text up to
 * `ThreadPanel`, which never itself remounts on that switch, keeps it alive
 * across a resize.
 */
function NewThreadComposer({
	quoteText,
	draft,
	onDraftChange,
	submitting,
	onSubmittingChange,
	error,
	onErrorChange,
	onSubmit,
	onCancel,
}: {
	quoteText: string;
	draft: string;
	onDraftChange: (value: string) => void;
	submitting: boolean;
	onSubmittingChange: (value: boolean) => void;
	error: string | null;
	onErrorChange: (value: string | null) => void;
	onSubmit: (text: string) => Promise<void>;
	onCancel: () => void;
}) {
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	// Lands the keyboard in the compose box the moment it opens -- mirrors
	// the old `CommentComposer`'s own auto-focus behavior for its inline
	// textarea, now that this composer replaces it. Also refires after a
	// mobile/desktop remount, which re-focuses the (now-remounted) textarea --
	// desirable, since the draft text itself survives that remount via the
	// lifted state above.
	useEffect(() => {
		textareaRef.current?.focus();
	}, []);

	const handleSubmit = () => {
		const text = draft.trim();
		if (!text || submitting) return;
		onSubmittingChange(true);
		onErrorChange(null);
		onSubmit(text).then(
			() => {
				onDraftChange("");
				onSubmittingChange(false);
			},
			(err: unknown) => {
				onSubmittingChange(false);
				onErrorChange(err instanceof Error ? err.message : String(err));
			},
		);
	};

	return (
		<div
			className="flex flex-col gap-2 rounded-sm border border-border bg-card p-2"
			data-new-thread-composer
		>
			{quoteText ? (
				<blockquote
					className="m-0 border-border border-s-2 ps-2 text-[12px] text-muted-foreground italic"
					data-new-thread-quote
				>
					{quoteText}
				</blockquote>
			) : null}
			<textarea
				ref={textareaRef}
				className="min-h-14 w-full resize-none rounded-sm border border-input bg-card px-2 py-1.5 text-[12px] outline-hidden focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-11 max-md:text-base"
				data-new-thread-textarea
				disabled={submitting}
				placeholder="Add a comment..."
				value={draft}
				onChange={(event) => {
					onDraftChange(event.target.value);
					onErrorChange(null);
				}}
			/>
			{error ? (
				<p className="m-0 text-destructive text-xs" data-new-thread-error>
					{error}
				</p>
			) : null}
			<div className="flex items-center gap-2">
				<Button
					type="button"
					size="sm"
					data-new-thread-submit
					disabled={submitting || draft.trim().length === 0}
					onClick={handleSubmit}
				>
					Post
				</Button>
				<Button
					type="button"
					variant="outline"
					size="sm"
					data-new-thread-cancel
					disabled={submitting}
					onClick={onCancel}
				>
					Cancel
				</Button>
			</div>
		</div>
	);
}

/** Exported as part of this package's public surface (see `index.ts`) so a host can render this same thread markup (reply/resolve/reopen/delete) outside `ThreadPanel` if it ever needs to, without duplicating it. */
export function ThreadItem({
	thread,
	focused,
	onReply,
	onResolve,
	onReopen,
	onDelete,
	onJumpToThread,
}: {
	thread: ResolvedThread;
	focused: boolean;
	onReply: (threadId: string, text: string) => Promise<void>;
	onResolve: (threadId: string) => Promise<void>;
	onReopen: (threadId: string) => Promise<void>;
	// Optional (mirrors CommentOptions.onDelete): hosts that haven't wired
	// deletion get a thread without a Delete button, never a crash.
	onDelete?: (threadId: string) => Promise<void>;
	onJumpToThread?: (threadId: string) => void;
}) {
	const [draft, setDraft] = useState("");
	const [actionError, setActionError] = useState<string | null>(null);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const isResolved = thread.state === "resolved";
	const isOrphaned = thread.anchorResolution.status === "orphaned";

	const describeError = (err: unknown): string =>
		err instanceof Error ? err.message : String(err);

	const submitReply = () => {
		const text = draft.trim();
		if (!text) return;
		onReply(thread.id, text).then(
			() => {
				setDraft("");
				setActionError(null);
			},
			(err: unknown) => setActionError(describeError(err)),
		);
	};

	const handleResolve = () => {
		onResolve(thread.id).then(
			() => setActionError(null),
			(err: unknown) => setActionError(describeError(err)),
		);
	};

	const handleReopen = () => {
		onReopen(thread.id).then(
			() => setActionError(null),
			(err: unknown) => setActionError(describeError(err)),
		);
	};

	const handleDeleteRequest = () => {
		setActionError(null);
		setConfirmingDelete(true);
	};

	const handleDeleteConfirm = () => {
		if (!onDelete) {
			setConfirmingDelete(false);
			return;
		}
		onDelete(thread.id).then(
			() => {
				setActionError(null);
				setConfirmingDelete(false);
			},
			(err: unknown) => setActionError(describeError(err)),
		);
	};

	const handleDeleteCancel = () => {
		setConfirmingDelete(false);
		setActionError(null);
	};

	return (
		<li
			className="flex flex-col gap-2 rounded-sm border border-border p-2"
			data-comment-thread
			data-thread-id={thread.id}
			data-thread-focused={focused}
			data-thread-state={thread.state}
		>
			<div
				className="flex cursor-pointer flex-col gap-2 rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring/40"
				data-thread-jump-target
				data-thread-id={thread.id}
				role="button"
				tabIndex={onJumpToThread ? 0 : -1}
				aria-label="Scroll to this comment in the document"
				onClick={() => onJumpToThread?.(thread.id)}
				onKeyDown={(event) => {
					if (event.key !== "Enter" && event.key !== " ") return;
					event.preventDefault();
					onJumpToThread?.(thread.id);
				}}
			>
				<div className="flex items-center gap-2">
					{isOrphaned ? (
						<span
							className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
							data-orphaned-badge
						>
							orphaned
						</span>
					) : null}
				</div>
				<ul className="m-0 flex list-none flex-col gap-1.5 p-0">
					<ThreadLogLine
						by={thread.opener.by}
						verb="opened"
						text={thread.opener.text}
					/>
					{thread.events.map((event) => (
						<ThreadLogLine
							key={event.id}
							by={event.by}
							verb={eventVerb(event.kind)}
							text={event.text}
						/>
					))}
				</ul>
			</div>

			<textarea
				className="min-h-14 w-full resize-none rounded-sm border border-input bg-card px-2 py-1.5 text-[12px] outline-hidden focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-11 max-md:text-base"
				data-reply-textarea
				data-thread-id={thread.id}
				disabled={isResolved}
				placeholder={isResolved ? "Reopen to reply" : "Reply..."}
				value={draft}
				onChange={(event) => {
					setDraft(event.target.value);
					setActionError(null);
				}}
			/>

			{actionError ? (
				<p className="m-0 text-destructive text-xs" data-thread-action-error>
					{actionError}
				</p>
			) : null}

			<div className="flex items-center gap-2">
				{isResolved ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						data-reopen-button
						data-thread-id={thread.id}
						onClick={handleReopen}
					>
						Reopen to reply
					</Button>
				) : (
					<>
						<Button
							type="button"
							size="sm"
							data-reply-button
							data-thread-id={thread.id}
							onClick={submitReply}
						>
							Reply
						</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
							data-resolve-button
							data-thread-id={thread.id}
							onClick={handleResolve}
						>
							Resolve
						</Button>
					</>
				)}
				{onDelete ? (
					confirmingDelete ? (
						<>
							<Button
								type="button"
								variant="destructive"
								size="sm"
								data-confirm-delete-button
								data-thread-id={thread.id}
								onClick={handleDeleteConfirm}
							>
								Confirm delete
							</Button>
							<Button
								type="button"
								variant="outline"
								size="sm"
								data-cancel-delete-button
								data-thread-id={thread.id}
								onClick={handleDeleteCancel}
							>
								Cancel
							</Button>
						</>
					) : (
						<Button
							type="button"
							variant="outline"
							size="sm"
							data-delete-button
							data-thread-id={thread.id}
							onClick={handleDeleteRequest}
						>
							Delete
						</Button>
					)
				) : null}
			</div>
		</li>
	);
}

export function ThreadPanel(props: {
	threads: ResolvedThread[];
	currentAuthor: CommentAuthor;
	focusedThreadId?: string | null;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	onReply: (threadId: string, text: string) => Promise<void>;
	onResolve: (threadId: string) => Promise<void>;
	onReopen: (threadId: string) => Promise<void>;
	// Optional: hosts without deletion wired get threads with no Delete
	// button, never a crash.
	onDelete?: (threadId: string) => Promise<void>;
	onJumpToThread?: (threadId: string) => void;
	error?: string | null;
	/** Non-null while a brand-new comment is being drafted (from `CommentComposer`'s trigger). Renders a composer pinned above the thread list and auto-opens the panel. */
	composing?: { anchor: TextAnchor; quoteText: string } | null;
	onSubmitNewThread?: (anchor: TextAnchor, text: string) => Promise<void>;
	onCancelCompose?: () => void;
}) {
	const {
		threads,
		focusedThreadId,
		open,
		onOpenChange,
		onReply,
		onResolve,
		onReopen,
		onDelete,
		onJumpToThread,
		error,
		composing,
		onSubmitNewThread,
		onCancelCompose,
	} = props;
	const listRef = useRef<HTMLUListElement | null>(null);

	// Controlled when the host passes both `open` and `onOpenChange` (so it
	// can coordinate "only one right-edge panel open at a time" against its
	// own other panels, R21); falls back to internal state otherwise. Mirrors
	// `apps/desktop/src/components/RevisionHistoryPanel.tsx`'s contract.
	const [internalOpen, setInternalOpen] = useState(false);
	const isControlled = open !== undefined && onOpenChange !== undefined;
	const resolvedOpen = isControlled ? open : internalOpen;
	const handleOpenChange = isControlled ? onOpenChange : setInternalOpen;

	// A new-comment composer opening is itself a reason to open the panel --
	// same as a paragraph/gutter marker click focusing a thread already does
	// via `handleSelectThread` in the wiring layer.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only `composing` becoming non-null should trigger this; `handleOpenChange`'s identity is not itself an "open the panel" event.
	useEffect(() => {
		if (composing) handleOpenChange(true);
	}, [composing]);

	// Draft state for `NewThreadComposer`, lifted up here rather than kept as
	// that component's own local state: this panel renders as either a
	// `SidePanel` or a `BottomSheet` depending on `isMobile` below, and the two
	// wrap children in different Dialog trees, so crossing that breakpoint
	// mid-draft unmounts and remounts `NewThreadComposer` (this `ThreadPanel`
	// component itself does not remount -- only its returned JSX subtree
	// changes). Local state there would reset to "" on every such resize;
	// state here survives it. Reset to a clean slate whenever a *new* compose
	// session starts (a freshly-allocated `composing` object -- see
	// `EditorView.tsx`'s `handleStartComposing`) or ends (`composing` back to
	// null), so a stale error/draft from a finished session never leaks into
	// the next one.
	const [newThreadDraft, setNewThreadDraft] = useState("");
	const [newThreadSubmitting, setNewThreadSubmitting] = useState(false);
	const [newThreadError, setNewThreadError] = useState<string | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: only `composing`'s own identity changing (a new session, or back to null) should reset the draft; the setters below are stable and reading `composing`'s fields isn't the point here.
	useEffect(() => {
		setNewThreadDraft("");
		setNewThreadSubmitting(false);
		setNewThreadError(null);
	}, [composing]);

	// Scrolls the focused thread into view within the panel's own list --
	// covers both the paragraph-marker/gutter-marker "select" path (which
	// sets focusedThreadId and opens the panel in the same tick) and simply
	// reopening the panel while a thread is already focused. Deliberately not
	// keyed on `threads` itself: that array gets a new reference on nearly
	// every editor keystroke (useCommentThreads re-resolves on every
	// "transaction"), which would otherwise re-trigger a scroll on every
	// keystroke while the panel is open.
	useEffect(() => {
		if (!resolvedOpen || !focusedThreadId) return;
		listRef.current
			?.querySelector<HTMLElement>(`[data-thread-id="${focusedThreadId}"]`)
			?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}, [resolvedOpen, focusedThreadId]);

	// Below `md` the panel renders as a keyboard-aware bottom sheet (half
	// height, drag to full) instead of the right-edge SidePanel — same
	// threads, same actions, same focused-thread scroll. Desktop is untouched.
	const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);

	const content = (
		<>
			{composing && onSubmitNewThread && onCancelCompose ? (
				<NewThreadComposer
					quoteText={composing.quoteText}
					draft={newThreadDraft}
					onDraftChange={setNewThreadDraft}
					submitting={newThreadSubmitting}
					onSubmittingChange={setNewThreadSubmitting}
					error={newThreadError}
					onErrorChange={setNewThreadError}
					onSubmit={(text) => onSubmitNewThread(composing.anchor, text)}
					onCancel={onCancelCompose}
				/>
			) : null}
			{error ? (
				<p className="m-0 text-destructive text-sm" data-comment-panel-error>
					{error}
				</p>
			) : threads.length === 0 ? (
				<p
					className="m-0 text-muted-foreground text-sm"
					data-comment-panel-empty
				>
					No comments yet
				</p>
			) : (
				<ul
					ref={listRef}
					className="m-0 flex min-h-0 flex-1 list-none flex-col gap-2 overflow-y-auto p-0"
					data-comment-thread-list
				>
					{threads.map((thread) => (
						<ThreadItem
							key={thread.id}
							thread={thread}
							focused={thread.id === focusedThreadId}
							onReply={onReply}
							onResolve={onResolve}
							onReopen={onReopen}
							onDelete={onDelete}
							onJumpToThread={onJumpToThread}
						/>
					))}
				</ul>
			)}
		</>
	);

	if (isMobile) {
		return (
			<BottomSheet
				open={resolvedOpen}
				onOpenChange={handleOpenChange}
				title="Comments"
			>
				{content}
			</BottomSheet>
		);
	}

	return (
		<SidePanel
			open={resolvedOpen}
			onOpenChange={handleOpenChange}
			title="Comments"
		>
			{content}
		</SidePanel>
	);
}
