export { buildQuoteAnchor } from "./buildAnchor.js";
export {
	buildCommentDecorations,
	CommentExtension,
	commentThreadsKey,
	setCommentThreads,
} from "./CommentExtension.js";
export { CommentComposer } from "./CommentComposer.js";
export { CommentGutter } from "./CommentGutter.js";
export { ThreadPanel } from "./ThreadPanel.js";
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
export { type ResolvedThread, useCommentThreads } from "./useCommentThreads.js";
