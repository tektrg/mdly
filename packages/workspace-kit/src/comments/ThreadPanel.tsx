import { useState } from "react";
import { Button } from "../primitives/button.js";
import { SidePanel } from "../primitives/sidePanel.js";
import type { CommentAuthor, CommentThreadEvent } from "./types.js";
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
			{text ? <span>{text}</span> : null}
		</li>
	);
}

function ThreadItem({
	thread,
	focused,
	onReply,
	onResolve,
	onReopen,
}: {
	thread: ResolvedThread;
	focused: boolean;
	onReply: (threadId: string, text: string) => Promise<void>;
	onResolve: (threadId: string) => Promise<void>;
	onReopen: (threadId: string) => Promise<void>;
}) {
	const [draft, setDraft] = useState("");
	const [actionError, setActionError] = useState<string | null>(null);
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

	return (
		<li
			className="flex flex-col gap-2 rounded-sm border border-border p-2"
			data-comment-thread
			data-thread-id={thread.id}
			data-thread-focused={focused}
			data-thread-state={thread.state}
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

			<textarea
				className="min-h-14 w-full resize-none rounded-sm border border-input bg-card px-2 py-1.5 text-[12px] outline-hidden focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
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
	error?: string | null;
}) {
	const {
		threads,
		focusedThreadId,
		open,
		onOpenChange,
		onReply,
		onResolve,
		onReopen,
		error,
	} = props;

	// Controlled when the host passes both `open` and `onOpenChange` (so it
	// can coordinate "only one right-edge panel open at a time" against its
	// own other panels, R21); falls back to internal state otherwise. Mirrors
	// `apps/desktop/src/components/RevisionHistoryPanel.tsx`'s contract.
	const [internalOpen, setInternalOpen] = useState(false);
	const isControlled = open !== undefined && onOpenChange !== undefined;
	const resolvedOpen = isControlled ? open : internalOpen;
	const handleOpenChange = isControlled ? onOpenChange : setInternalOpen;

	return (
		<SidePanel open={resolvedOpen} onOpenChange={handleOpenChange} title="Comments">
			{error ? (
				<p
					className="m-0 text-destructive text-sm"
					data-comment-panel-error
				>
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
						/>
					))}
				</ul>
			)}
		</SidePanel>
	);
}
