import { mergeAttributes, Node } from "@tiptap/core";

/**
 * Notion-style collapsible "toggle" block, backed by `<details><summary>`.
 *
 * The `open` attribute only seeds the NodeView's initial expand/collapse
 * state (see ToggleBlockView); expand/collapse afterwards is local UI state,
 * never written back to attrs or serialized, so clicking a toggle never
 * dirties the document. See markdownToProsemirror / prosemirrorToMarkdown
 * for the round-trip mapping.
 */
export const ToggleExtension = Node.create({
	name: "toggle",
	group: "block",
	content: "toggleSummary block+",
	defining: true,

	addAttributes() {
		return {
			open: {
				default: false,
				parseHTML: (element) => element.hasAttribute("open"),
				renderHTML: (attributes) => (attributes.open ? { open: "" } : {}),
			},
		};
	},

	parseHTML() {
		return [{ tag: "details" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["details", mergeAttributes(HTMLAttributes), 0];
	},
});

export const ToggleSummaryExtension = Node.create({
	name: "toggleSummary",
	content: "inline*",
	defining: true,
	isolating: true,

	parseHTML() {
		return [{ tag: "summary" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["summary", mergeAttributes(HTMLAttributes), 0];
	},
});

export const toggleBlockExtensions = [ToggleExtension, ToggleSummaryExtension];
