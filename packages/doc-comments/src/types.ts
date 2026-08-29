import type { RevisionAuthor } from "@mdly/doc-history";

export type CommentAuthor = RevisionAuthor;

/** Anchor in rendered-text space (PM doc positions / flattened text offsets). */
export interface TextAnchor {
	/** Position in flattened rendered text where the anchor begins. */
	from: number;
	/** Position in flattened rendered text where the anchor ends. */
	to: number;
	/** Text that was anchored, for fallback quote-based recovery. */
	quote: string;
	/**
	 * When mode is 'revision', the offset was anchored against a specific
	 * revision's bytes and is valid by construction. When mode is 'quote',
	 * the offset is anchored against the live draft text and may require
	 * fallback search if the revision is unavailable later.
	 */
	mode: "revision" | "quote";
	/**
	 * The revision id this anchor was recorded against, if mode is 'revision'.
	 * Used to replay diffRegions from that revision to the current text.
	 */
	revisionId?: string;
	/**
	 * Flattened text immediately before `quote`, captured at comment time.
	 * Used only by the quote+context fallback to disambiguate repeated quotes.
	 */
	contextBefore?: string;
	/**
	 * Flattened text immediately after `quote`, captured at comment time.
	 * Used only by the quote+context fallback to disambiguate repeated quotes.
	 */
	contextAfter?: string;
}

export type CommentEventKind = "thread-opened" | "replied" | "resolved" | "reopened";

export interface CommentEvent {
	id: string;
	kind: CommentEventKind;
	/** The id of the previous event in this thread, or null if this is the thread-opened event. */
	prev: string | null;
	/** The thread id (same for all events in a thread). For thread-opened, typically same as id; for others, the thread's opener id. */
	threadId: string;
	/** Author of this event. */
	by: CommentAuthor;
}

export interface ThreadOpenedEvent extends CommentEvent {
	kind: "thread-opened";
	/** Text anchor where the comment was written. */
	anchor: TextAnchor;
	/** Initial message body. */
	text: string;
}

export interface RepliedEvent extends CommentEvent {
	kind: "replied";
	/** Message reply text. */
	text: string;
}

export interface ResolvedEvent extends CommentEvent {
	kind: "resolved";
}

export interface ReopenedEvent extends CommentEvent {
	kind: "reopened";
}

export type AnyCommentEvent =
	| ThreadOpenedEvent
	| RepliedEvent
	| ResolvedEvent
	| ReopenedEvent;

/** Resolved thread state derived from the event log's head event. */
export type ThreadState = "open" | "resolved";

/** Anchor resolution result. */
export type AnchorStatus = "anchored" | "orphaned" | "fallback-anchored";

export interface AnchorResolution {
	status: AnchorStatus;
	range?: { from: number; to: number };
	/** The method used to resolve the anchor (for debugging/testing). */
	method?: "revision-replay" | "quote-context";
}

/** A thread as read from the store. */
export interface CommentThread {
	id: string;
	docId: string;
	/** The thread-opened event for this thread. */
	opener: ThreadOpenedEvent;
	/** All events in this thread (thread-opened first, then replies/resolves/reopens). */
	events: AnyCommentEvent[];
	/** Derived thread state from the head event. */
	state: ThreadState;
	/** Resolved anchor for this thread against the current document text. */
	anchorResolution: AnchorResolution;
}

/** Options for opening a thread. */
export interface OpenThreadOptions {
	docId: string;
	/** Author of the comment. */
	author: CommentAuthor;
	/** Text range being commented on. */
	anchor: TextAnchor;
	/** Initial comment message. */
	text: string;
}

/** Options for replying to a thread. */
export interface ReplyOptions {
	docId: string;
	threadId: string;
	/** Author of the reply. */
	author: CommentAuthor;
	/** Reply text. */
	text: string;
}

/** Options for resolving a thread. */
export interface ResolveOptions {
	docId: string;
	threadId: string;
	/** Author of the resolve action. */
	author: CommentAuthor;
}

/** Options for reopening a thread. */
export interface ReopenOptions {
	docId: string;
	threadId: string;
	/** Author of the reopen action. */
	author: CommentAuthor;
}
