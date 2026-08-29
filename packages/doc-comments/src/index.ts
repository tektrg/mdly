export type {
	CommentAuthor,
	TextAnchor,
	CommentEvent,
	CommentEventKind,
	ThreadOpenedEvent,
	RepliedEvent,
	ResolvedEvent,
	ReopenedEvent,
	AnyCommentEvent,
	ThreadState,
	AnchorStatus,
	AnchorResolution,
	CommentThread,
	OpenThreadOptions,
	ReplyOptions,
	ResolveOptions,
	ReopenOptions,
} from "./types.js";
export {
	commentsDirPath,
	commentLogPath,
	appendCommentEvent,
	readCommentEvents,
	findCommentLogSiblings,
} from "./commentLog.js";
export {
	resolveAnchor,
	type ReadRevisionContent,
	type FlattenDocument,
} from "./anchor.js";
export {
	listThreads,
	openThread,
	reply,
	resolve,
	reopen,
	type CommentStoreOptions,
} from "./commentStore.js";
