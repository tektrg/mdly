export {
	type FlattenDocument,
	type ReadRevisionContent,
	resolveAnchor,
} from "./anchor.js";
export {
	appendCommentEvent,
	commentLogPath,
	commentsDirPath,
	findCommentLogSiblings,
	readCommentEvents,
} from "./commentLog.js";
export {
	type CommentStoreOptions,
	deleteThread,
	listThreads,
	openThread,
	reopen,
	reply,
	resolve,
} from "./commentStore.js";
export type {
	AnchorResolution,
	AnchorStatus,
	AnyCommentEvent,
	CommentAuthor,
	CommentEvent,
	CommentEventKind,
	CommentThread,
	DeletedEvent,
	DeleteOptions,
	OpenThreadOptions,
	ReopenedEvent,
	ReopenOptions,
	RepliedEvent,
	ReplyOptions,
	ResolvedEvent,
	ResolveOptions,
	TextAnchor,
	ThreadOpenedEvent,
	ThreadState,
} from "./types.js";
