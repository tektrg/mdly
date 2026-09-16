export { buildQuoteAnchor } from "./buildAnchor.js";
export { CommentComposer } from "./CommentComposer.js";
export type {
	CommentThreadsPluginState,
	PendingCommentAnchorRange,
} from "./CommentExtension.js";
export {
	buildCommentDecorations,
	CommentExtension,
	commentThreadsKey,
	pendingCommentAnchorKey,
	setCommentThreads,
	setPendingCommentAnchor,
} from "./CommentExtension.js";
export { CommentMarkdown } from "./CommentMarkdown.js";
export { CommentParagraphMarker } from "./CommentParagraphMarker.js";
export { ThreadItem, ThreadPanel } from "./ThreadPanel.js";
export type {
	AnchorResolution,
	AnchorStatus,
	CommentAuthor,
	CommentAuthorKind,
	CommentOptions,
	CommentThread,
	CommentThreadEvent,
	CommentThreadEventKind,
	TextAnchor,
	ThreadState,
} from "./types.js";
export { useCommentMarkClick } from "./useCommentMarkClick.js";
export { type ResolvedThread, useCommentThreads } from "./useCommentThreads.js";
