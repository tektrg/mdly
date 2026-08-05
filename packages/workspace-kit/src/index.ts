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

// ---- Navigation (Sidebar, Toolbar, WorkspaceSwitcher, recent files) ----
export {
	Sidebar,
	type SidebarFile,
	type SidebarFocusedItem,
	type SidebarFolder,
	SidebarFrame,
	type SidebarMoveItemInput,
	type SidebarSortMode,
} from "./nav/Sidebar";
export { NewNoteButton, Toolbar } from "./nav/Toolbar";
export { WorkspaceSwitcherMenu } from "./nav/WorkspaceSwitcherMenu";

// ---- Shared primitives ----
export { Button, buttonVariants } from "./primitives/button";
export { Input } from "./primitives/input";
export { Modal } from "./primitives/modal";
export { Separator } from "./primitives/separator";

// ---- Popup mount-target (theming contract, Phase 2) ----
export {
	PortalContainerProvider,
	type PortalContainerProviderProps,
	usePortalContainer,
} from "./lib/portalContainer";
