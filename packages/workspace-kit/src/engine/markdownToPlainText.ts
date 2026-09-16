import type { JSONContent } from "@tiptap/core";
import { parseMarkdownFrontMatter } from "./frontMatter.js";
import { markdownToTiptapDoc } from "./markdownToProsemirror.js";
import {
	hasLinkedNotionFrontMatter,
	normalizeNotionMarkdownBody,
} from "./notionMarkdownNormalization.js";

const BLOCK_NODE_TYPES = new Set([
	"paragraph",
	"heading",
	"bulletList",
	"orderedList",
	"listItem",
	"taskList",
	"taskItem",
	"blockquote",
	"codeBlock",
	"table",
	"tableRow",
	"tableCell",
	"tableHeader",
	"notionCallout",
	"toggle",
	"toggleSummary",
]);

/**
 * Strips front matter from raw markdown if present, normalizing Notion bodies
 * when applicable (matching EditorView and buildAnchor's extractBody).
 */
function extractBody(rawMarkdown: string): string {
	const parsed = parseMarkdownFrontMatter(rawMarkdown);
	if (parsed.type === "none") return parsed.body;
	return hasLinkedNotionFrontMatter(parsed.raw)
		? normalizeNotionMarkdownBody(parsed.body)
		: parsed.body;
}

/**
 * Flattens Markdown content to rendered plain text space, matching ProseMirror's
 * `doc.textBetween(0, doc.content.size, "\n")`.
 *
 * This strips Markdown syntax (e.g. bold `**`, code backticks, table delimiters `|`,
 * list markers `- `) and preserves block-level separation (`\n`). Used by anchor
 * resolution (`resolveAnchor` in `@mdly/doc-comments`) and comment indexing across
 * the editor and backend tools.
 */
export function markdownToPlainText(markdown: string): string {
	const body = extractBody(markdown);
	if (body.length === 0) return "";

	const tiptapDoc = markdownToTiptapDoc(body);
	let result = "";
	let separated = true;

	function walk(node: JSONContent) {
		if (!separated && node.type && BLOCK_NODE_TYPES.has(node.type)) {
			result += "\n";
			separated = true;
		}

		if (node.text) {
			result += node.text;
			separated = false;
		}

		if (node.content && Array.isArray(node.content)) {
			for (const child of node.content) {
				walk(child);
			}
		}
	}

	walk(tiptapDoc);
	return result;
}
