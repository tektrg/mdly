// Locally-declared, structurally identical to `@mdly/doc-comments`'s
// `CommentAuthor`/`TextAnchor`/`AnyCommentEvent`/`ThreadState`/`AnchorStatus`/
// `AnchorResolution`/`CommentThread` (charter D4: the kit's published `.d.ts`
// must never reference `@mdly/doc-comments`, so downstream consumers of the
// kit don't need that package resolvable). Mirrors the same convention
// `history/RevisionList.tsx` already uses for `@mdly/doc-history`'s
// `Revision`/`RevisionAuthor` shapes.

export type CommentAuthorKind = "human" | "agent" | "external";

export interface CommentAuthor {
	kind: CommentAuthorKind;
	id: string;
	label?: string;
}

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

export type CommentThreadEventKind =
	| "thread-opened"
	| "replied"
	| "resolved"
	| "reopened";

/** UI-facing log-line shape for a single event in a thread's history. */
export interface CommentThreadEvent {
	id: string;
	kind: CommentThreadEventKind;
	by: CommentAuthor;
	/** Message body, present for "thread-opened"/"replied", absent for "resolved"/"reopened". */
	text?: string;
	/** The id of the previous event in this thread, or null if this is the thread-opened event. */
	prev: string | null;
}

/** A thread as read from the store, shaped for the panel/decoration UI. */
export interface CommentThread {
	id: string;
	/** The thread-opened event, rendered first in the panel's log. */
	opener: {
		id: string;
		by: CommentAuthor;
		anchor: TextAnchor;
		text: string;
	};
	/** Every reply/resolve/reopen event after the opener, in display order. */
	events: CommentThreadEvent[];
	state: ThreadState;
}

export interface CommentOptions {
	/** Author identity to attach to writes this session makes. */
	currentAuthor: CommentAuthor;
	/** docId for the currently open document (host resolves this, e.g. via doc-history's resolveOrAssignDocId). */
	docId: string;
	/** Resolves the doc's current most-recent saved revision id (or null if it has none yet), fresh on every call -- never cache this, the editor mints new revisions mid-session on its own. Lets a new comment on unchanged saved text get D1/R10's `revision` anchor mode instead of always `quote`. */
	getHeadRevisionId: () => Promise<string | null>;
	/** Fetches the current raw thread list for docId. Called on mount and whenever refreshSignal changes. */
	getThreads: (docId: string) => Promise<CommentThread[]>;
	/** Reads a past revision's raw markdown body by revisionId, or null if unavailable. Host-injected (only the desktop main process can read revision blobs). */
	readRevisionContent: (revisionId: string) => Promise<string | null>;
	onOpenThread: (anchor: TextAnchor, text: string) => Promise<void>;
	onReply: (threadId: string, text: string) => Promise<void>;
	onResolve: (threadId: string) => Promise<void>;
	onReopen: (threadId: string) => Promise<void>;
	/** Bump this (e.g. a counter) to force a re-fetch of threads without remounting -- used for cross-window refresh (R22). */
	refreshSignal?: number;
	/** Controlled open state for the thread panel, so a host can coordinate "only one right-edge panel open" against its own other panels. Omit for an uncontrolled panel (its own internal open state). */
	panelOpen?: boolean;
	onPanelOpenChange?: (open: boolean) => void;
}
