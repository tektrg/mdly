import { mergeAttributes, Node } from "@tiptap/core";

export const NotionCalloutExtension = Node.create({
	name: "notionCallout",
	group: "block",
	content: "block+",
	defining: true,

	addAttributes() {
		return {
			icon: {
				default: null,
				parseHTML: (element) => element.getAttribute("data-icon"),
				renderHTML: (attributes) => {
					const icon = attributes.icon;
					return typeof icon === "string" && icon.length > 0
						? { "data-icon": icon }
						: {};
				},
			},
			rawAttributes: {
				default: "",
				renderHTML: () => ({}),
			},
		};
	},

	parseHTML() {
		return [{ tag: "aside[data-notion-callout]" }, { tag: "callout" }];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"aside",
			mergeAttributes(HTMLAttributes, { "data-notion-callout": "" }),
			0,
		];
	},
});

export const NotionEmptyBlockExtension = Node.create({
	name: "notionEmptyBlock",
	group: "block",
	atom: true,
	selectable: true,

	parseHTML() {
		return [{ tag: "div[data-notion-empty-block]" }, { tag: "empty-block" }];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"div",
			mergeAttributes(HTMLAttributes, { "data-notion-empty-block": "" }),
		];
	},
});

export const NotionHtmlBlockExtension = Node.create({
	name: "notionHtmlBlock",
	group: "block",
	atom: true,
	selectable: true,

	addAttributes() {
		return {
			raw: {
				default: "",
				renderHTML: () => ({}),
			},
		};
	},

	parseHTML() {
		return [{ tag: "div[data-notion-html-block]" }];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"div",
			mergeAttributes(HTMLAttributes, { "data-notion-html-block": "" }),
		];
	},
});

export const notionBlockExtensions = [
	NotionCalloutExtension,
	NotionEmptyBlockExtension,
	NotionHtmlBlockExtension,
];
