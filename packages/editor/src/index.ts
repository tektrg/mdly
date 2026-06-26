export { FakeSelectionExtension } from "./FakeSelectionExtension";
export {
	FindExtension,
	findMatches,
	getFindState,
	selectFindMatch,
	type FindMatch,
	type FindState,
} from "./FindExtension";
export {
	combineMarkdownFrontMatter,
	detectFilePropertyType,
	type FileProperty,
	type FilePropertyType,
	isDateString,
	isSimplePropertyKey,
	type ParsedFrontMatter,
	parseDateInput,
	parseMarkdownFrontMatter,
	serializeFrontMatter,
	setMarkdownFrontMatter,
} from "./frontMatter";
export { HeadingExtension } from "./Heading";
export {
	createLinkMark,
	getActiveLinkRange,
	getLinkHrefFromAttrs,
	LinkExtension,
	type LinkKind,
} from "./Link";
export {
	ListAutoJoinExtension,
	ListItemExtension,
	ListToggleExtension,
	listExtensions,
} from "./List";
export {
	type CaretFormattingState,
	getCaretFormattingState,
	MarkdownRolloverExtension,
} from "./MarkdownRolloverExtension";
export {
	hasMarkdownExtension,
	stripMarkdownExtension,
	wikiDisplayNameForTarget,
	withMarkdownExtension,
} from "./markdownPath";
export { markdownToTiptapDoc } from "./markdownToProsemirror";
export { tiptapDocToMarkdown } from "./prosemirrorToMarkdown";
export { StoredMarksDecorationExtension } from "./StoredMarksDecorationExtension";
export { StrikethroughShortcutExtension } from "./StrikethroughShortcutExtension";
export {
	isSelectionAtStartOfNode,
	nearestSharedParentOfType,
	parentsOfType,
	textEndPos,
	textStartPos,
} from "./utils";
