import { mergeAttributes, Node } from "@tiptap/core";

const RATIO = /^\d+(?::\d+)+$/;

/** CSS grid template for a columns group: `2:1` → `2fr 1fr`, else equal. */
export function columnsGridTemplate(
	ratio: unknown,
	columnCount: number,
): string {
	const count = Math.max(1, columnCount);
	const parts =
		typeof ratio === "string" && RATIO.test(ratio) ? ratio.split(":") : [];
	return Array.from(
		{ length: count },
		(_, index) => `minmax(0, ${Number(parts[index] ?? 1) || 1}fr)`,
	).join(" ");
}

/**
 * Side-by-side layout block, stored as `::: columns [ratio]` … `+++` … `:::`
 * (see markdownToProsemirror / prosemirrorToMarkdown). Column count is the
 * number of `column` children; `ratio` is the optional `2:1` width ratio.
 */
export const ColumnsExtension = Node.create({
	name: "columns",
	group: "block",
	content: "column+",
	defining: true,
	isolating: true,

	addAttributes() {
		return {
			ratio: {
				default: null,
				parseHTML: (element) => element.getAttribute("data-ratio"),
				renderHTML: (attributes) =>
					typeof attributes.ratio === "string"
						? { "data-ratio": attributes.ratio }
						: {},
			},
		};
	},

	parseHTML() {
		return [{ tag: "div[data-columns]" }];
	},

	renderHTML({ node, HTMLAttributes }) {
		return [
			"div",
			mergeAttributes(HTMLAttributes, {
				"data-columns": "",
				class: "pm-columns",
				style: `--pm-columns-template: ${columnsGridTemplate(node.attrs.ratio, node.childCount)}`,
			}),
			0,
		];
	},
});

export const ColumnExtension = Node.create({
	name: "column",
	content: "block+",
	isolating: true,
	defining: true,

	parseHTML() {
		return [{ tag: "div[data-column]" }];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"div",
			mergeAttributes(HTMLAttributes, {
				"data-column": "",
				class: "pm-column",
			}),
			0,
		];
	},
});

export const columnsExtensions = [ColumnsExtension, ColumnExtension];
