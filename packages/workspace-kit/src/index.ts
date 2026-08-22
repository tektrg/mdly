// Self-compiled Tailwind + component CSS for this package's own UI (navigation
// and the editor surface). Side-effect import so it lands in the bundled
// output; consumers additively import "@mdly/workspace-kit/style.css".
import "./tailwind.css";

// ---- Engine (Tiptap/ProseMirror Markdown core, zero UI deps) ----
export { FakeSelectionExtension } from "./engine/FakeSelectionExtension.js";
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
} from "./engine/frontMatter.js";
export { HeadingExtension } from "./engine/Heading.js";
export {
	createLinkMark,
	getActiveLinkRange,
	getLinkHrefFromAttrs,
	LinkExtension,
	type LinkKind,
} from "./engine/Link.js";
export {
	ListAutoJoinExtension,
	ListItemExtension,
	ListToggleExtension,
	listExtensions,
} from "./engine/List.js";
export {
	type CaretFormattingState,
	getCaretFormattingState,
	MarkdownRolloverExtension,
} from "./engine/MarkdownRolloverExtension.js";
export { MermaidBlockExtension } from "./engine/MermaidBlock.js";
export {
	hasMarkdownExtension,
	stripMarkdownExtension,
	wikiDisplayNameForTarget,
	withMarkdownExtension,
} from "./engine/markdownPath.js";
export { markdownToTiptapDoc } from "./engine/markdownToProsemirror.js";
export {
	NotionCalloutExtension,
	NotionEmptyBlockExtension,
	NotionHtmlBlockExtension,
	notionBlockExtensions,
} from "./engine/NotionBlocks.js";
export {
	hasLinkedNotionFrontMatter,
	normalizeNotionMarkdownBody,
} from "./engine/notionMarkdownNormalization.js";
export { tiptapDocToMarkdown } from "./engine/prosemirrorToMarkdown.js";
export { StoredMarksDecorationExtension } from "./engine/StoredMarksDecorationExtension.js";
export { StrikethroughShortcutExtension } from "./engine/StrikethroughShortcutExtension.js";
export {
	TableCellExtension,
	TableExtension,
	TableHeaderExtension,
	TableRowExtension,
	tableExtensions,
} from "./engine/Table.js";
export {
	isSelectionAtStartOfNode,
	nearestSharedParentOfType,
	parentsOfType,
	textEndPos,
	textStartPos,
} from "./engine/utils.js";
// ---- History (diff review + revision timeline, on top of @mdly/doc-history) ----
export {
	DiffReviewPanel,
	type DiffReviewPanelProps,
} from "./history/DiffReviewPanel";
export {
	type ReadRevisionContentResult,
	type Revision,
	type RevisionAuthor,
	type RevisionAuthorKind,
	type RevisionCause,
	RevisionTimeline,
	type RevisionTimelineProps,
} from "./history/RevisionTimeline";
// ---- Popup mount-target (theming contract, Phase 2) ----
export {
	PortalContainerProvider,
	type PortalContainerProviderProps,
	usePortalContainer,
} from "./lib/portalContainer";
// ---- Navigation (Sidebar, Toolbar, WorkspaceSwitcher, recent files, tags, search) ----
export {
	buildSearchResults,
	buildSidebarSearchIndex,
	type SidebarSearchIndexEntry,
	type SidebarSearchResult,
	searchSidebarFiles,
} from "./nav/buildSearchResults";
export { buildTagCounts, type SidebarTag } from "./nav/buildTagCounts";
export { SearchList } from "./nav/SearchList";
export {
	Sidebar,
	type SidebarFile,
	type SidebarFocusedItem,
	type SidebarFolder,
	SidebarFrame,
	type SidebarHandle,
	type SidebarMoveItemInput,
	type SidebarSortMode,
} from "./nav/Sidebar";
// Also reachable as "@mdly/workspace-kit/search" -- a UI-free entry point for
// consumers that want only the ranking (see vite.config.ts).
export {
	isSubsequence,
	normalizeSearchText,
	scoreText,
} from "./nav/searchScore";
export { TagList } from "./nav/TagList";
export { NewNoteButton, Toolbar } from "./nav/Toolbar";
export { WorkspaceSwitcherMenu } from "./nav/WorkspaceSwitcherMenu";
// ---- Shared primitives ----
export { Button, buttonVariants } from "./primitives/button";
export { Input } from "./primitives/input";
export { Modal } from "./primitives/modal";
export { Separator } from "./primitives/separator";
// ---- Editor surface (slash menu, format menu, find/replace, TOC, etc.) ----
export {
	EditorView,
	type EditorViewProps,
	type WikiTarget,
} from "./ui/EditorView";
export { FormattingStatusBar } from "./ui/FormattingStatusBar";
export { LinkCreationGhostExtension } from "./ui/LinkCreationGhostExtension";
export { SmartLinkExtension } from "./ui/SmartLinkExtension";
export { VirtualCursor } from "./ui/VirtualCursor";
export type { VirtualCursorMode } from "./ui/virtualCursorMode";
