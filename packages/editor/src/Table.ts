import { mergeAttributes, Node } from "@tiptap/core";

const tableCellAttributes = {
	align: {
		default: null,
		parseHTML: (element: HTMLElement) => element.getAttribute("align"),
		renderHTML: (attributes: { align?: string | null }) => {
			if (!attributes.align) return {};
			return { align: attributes.align };
		},
	},
};

export const TableExtension = Node.create({
	name: "table",
	group: "block",
	content: "tableRow+",
	isolating: true,

	parseHTML() {
		return [{ tag: "table" }];
	},

	renderHTML({ HTMLAttributes }) {
		// Wrapped so a table wider than the editor column scrolls on its own
		// axis, instead of forcing the whole document to scroll sideways.
		return [
			"div",
			{ class: "tableWrapper" },
			["table", mergeAttributes(HTMLAttributes), ["tbody", 0]],
		];
	},
});

export const TableRowExtension = Node.create({
	name: "tableRow",
	content: "(tableCell | tableHeader)*",

	parseHTML() {
		return [{ tag: "tr" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["tr", mergeAttributes(HTMLAttributes), 0];
	},
});

export const TableCellExtension = Node.create({
	name: "tableCell",
	content: "block+",
	isolating: true,
	addAttributes() {
		return tableCellAttributes;
	},

	parseHTML() {
		return [{ tag: "td" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["td", mergeAttributes(HTMLAttributes), 0];
	},
});

export const TableHeaderExtension = Node.create({
	name: "tableHeader",
	content: "block+",
	isolating: true,
	addAttributes() {
		return tableCellAttributes;
	},

	parseHTML() {
		return [{ tag: "th" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["th", mergeAttributes(HTMLAttributes), 0];
	},
});

export const tableExtensions = [
	TableExtension,
	TableRowExtension,
	TableCellExtension,
	TableHeaderExtension,
];
