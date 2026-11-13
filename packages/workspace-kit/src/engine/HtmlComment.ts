import { mergeAttributes, Node } from "@tiptap/core";

/**
 * HTML comments (`<!-- … -->`) — agents leave review notes this way. They are
 * modeled as atom nodes carrying the exact source bytes in `raw`, so the
 * page shows a collapsed marker instead of the raw text while save writes
 * the comment back byte-for-byte. `htmlComment` sits inline inside a
 * paragraph/list item/table cell; `htmlCommentBlock` is a comment alone on
 * its own line(s). The marker UI lives in `ui/HtmlCommentView.ts`.
 */

/** Exactly one complete comment, nothing before or after. */
const SINGLE_COMMENT = /^<!--((?:(?!-->)[\s\S])*)-->$/;

export function isSingleHtmlComment(raw: string): boolean {
	return SINGLE_COMMENT.test(raw);
}

/** The note text shown to the reader: the comment body, trimmed. */
export function htmlCommentText(raw: string): string {
	return (SINGLE_COMMENT.exec(raw)?.[1] ?? "").trim();
}

/** Null when `text` can be stored inside `<!-- … -->`, else a reason. */
export function validateHtmlCommentText(text: string): string | null {
	if (text.includes("-->") || text.includes("--!>")) {
		return "A note can't contain “-->”.";
	}
	return null;
}

/**
 * Rebuilds a comment around new text, keeping the original padding (`<!-- x
 * -->` vs `<!--x-->` vs multi-line) so an edit only changes the words.
 */
export function withHtmlCommentText(raw: string, text: string): string {
	const body = SINGLE_COMMENT.exec(raw)?.[1] ?? " ";
	let leading = /^\s*/.exec(body)?.[0] ?? "";
	let trailing = /\s*$/.exec(body)?.[0] ?? "";
	if (body.trim() === "" && body.length > 0) {
		leading = body;
		trailing = body;
	}
	// `<!-->` / `<!--->` would end the comment at once; a trailing `-` would
	// fuse with `-->`.
	if (!leading && /^-?>/.test(text)) leading = " ";
	if (!trailing && text.endsWith("-")) trailing = " ";
	return `<!--${leading}${text}${trailing}-->`;
}

const rawAttribute = {
	raw: {
		default: "",
		parseHTML: (element: HTMLElement) =>
			element.getAttribute("data-html-comment") ?? "",
		renderHTML: (attributes: Record<string, unknown>) => ({
			"data-html-comment":
				typeof attributes.raw === "string" ? attributes.raw : "",
		}),
	},
};

export const HtmlCommentExtension = Node.create({
	name: "htmlComment",
	group: "inline",
	inline: true,
	atom: true,
	selectable: true,
	draggable: false,

	addAttributes() {
		return rawAttribute;
	},

	parseHTML() {
		return [{ tag: "span[data-html-comment]" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["span", mergeAttributes(HTMLAttributes)];
	},

	renderText({ node }) {
		return typeof node.attrs.raw === "string" ? node.attrs.raw : "";
	},
});

export const HtmlCommentBlockExtension = Node.create({
	name: "htmlCommentBlock",
	group: "block",
	atom: true,
	selectable: true,
	draggable: false,

	addAttributes() {
		return rawAttribute;
	},

	parseHTML() {
		return [{ tag: "div[data-html-comment]" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["div", mergeAttributes(HTMLAttributes)];
	},
});
