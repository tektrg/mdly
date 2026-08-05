import { mergeAttributes, Node } from "@tiptap/core";

/**
 * Diagram block backed by a Mermaid source string.
 *
 * Stored in Markdown as a ```mermaid fenced code block, but modeled as an
 * atom node (rather than an editable code block) so the editor can show the
 * rendered diagram by default and reveal the source only on demand. The `raw`
 * attribute is the fenced block body; see markdownToProsemirror /
 * prosemirrorToMarkdown for the round-trip mapping.
 */
export const MermaidBlockExtension = Node.create({
	name: "mermaidBlock",
	group: "block",
	atom: true,
	selectable: true,

	addAttributes() {
		return {
			raw: {
				default: "",
				parseHTML: (element) => element.getAttribute("data-mermaid") ?? "",
				renderHTML: (attributes) =>
					typeof attributes.raw === "string"
						? { "data-mermaid": attributes.raw }
						: {},
			},
		};
	},

	parseHTML() {
		return [{ tag: "div[data-mermaid-block]" }];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"div",
			mergeAttributes(HTMLAttributes, { "data-mermaid-block": "" }),
		];
	},
});
