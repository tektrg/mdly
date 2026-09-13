import type { Editor } from "@tiptap/core";
import type { JSONContent } from "@tiptap/react";
import { markdownToTiptapDoc } from "../engine/index.js";

/**
 * Detects if a string contains CommonMark / GFM markdown syntax.
 */
export function hasMarkdownSyntax(text: string): boolean {
	// Headings: "# Title"
	if (/^#{1,6}\s+\S/m.test(text)) return true;
	// Bullet / numbered / task lists: "- ", "* ", "1. ", "- [ ] "
	if (/^\s*(?:[-*+]|\d+\.)\s+\S/m.test(text)) return true;
	// Blockquotes: "> "
	if (/^\s*>\s+\S/m.test(text)) return true;
	// Code fences: "```" or "~~~"
	if (/^(?:```|~~~)/m.test(text)) return true;
	// Inline code: `code`
	if (/`[^`]+`/.test(text)) return true;
	// Bold: **bold** or __bold__ (with boundary checks for _)
	if (/\*\*[^\s*][\s\S]*?\*\*/.test(text)) return true;
	if (/(?:^|\W)__[^\s_][\s\S]*?__(?:\W|$)/.test(text)) return true;
	// Italic: *italic* or _italic_ (with boundary checks for _)
	if (/(?:^|[^*])\*[^\s*][\s\S]*?\*(?:[^*]|$)/.test(text)) return true;
	if (/(?:^|\W)_[^\s_][\s\S]*?_(?:\W|$)/.test(text)) return true;
	// Strikethrough: ~~strike~~
	if (/~~[^\s~][\s\S]*?~~/.test(text)) return true;
	// Markdown links / images: [text](url) or ![alt](url)
	if (/!?\[[^\]]+\]\([^)]+\)/.test(text)) return true;
	// Wiki links: [[target]] or [[target|alias]]
	if (/\[\[[^\]]+\]\]/.test(text)) return true;
	// Tables: "| col |"
	if (/^\s*\|.+\|\s*$/m.test(text)) return true;
	// Toggle / Callout / HTML blocks: <details>, <callout>
	if (/<(?:details|callout|summary|iframe)\b/i.test(text)) return true;
	// Horizontal rules: "---", "***", "___"
	if (/^\s*(?:---|___|\*\*\*)\s*$/m.test(text)) return true;

	return false;
}

/**
 * Detects if HTML contains semantic formatting elements beyond generic containers.
 */
export function hasSemanticHtml(html: string): boolean {
	return /<(?:h[1-6]|b|strong|i|em|s|del|strike|u|ul|ol|li|blockquote|table|tr|td|th|pre|code)\b|<a\b[^>]*\shref\s*=/i.test(
		html,
	);
}

/**
 * Smart-paste: plain text is interpreted as Markdown source (bold, headings,
 * lists, toggle blocks, etc.) through the same converter used when a file is
 * opened from disk, so pasted markdown renders instead of landing as inert
 * literal text. Returns true when handled (the caller should treat the
 * default browser/ProseMirror paste as suppressed), false to fall through.
 */
export function handleMarkdownTextPaste(
	editor: Editor,
	event: ClipboardEvent,
): boolean {
	// Code blocks hold literal text -- a "##" or "- " inside one is data, not
	// markdown syntax to reinterpret.
	if (editor.state.selection.$from.parent.type.spec.code) return false;

	const html = event.clipboardData?.getData("text/html") ?? "";
	const text = event.clipboardData?.getData("text/plain");
	if (!text && !html) return false;

	// Internal copy from ProseMirror/Hubble contains data-pm-slice metadata in HTML.
	// Allow ProseMirror's default paste handler to insert the exact native slice.
	if (html.includes("data-pm-slice")) {
		return false;
	}

	// External rich HTML copy (e.g. from web browsers, Google Docs):
	// If the clipboard has rich semantic HTML, let ProseMirror's DOM parser
	// convert the HTML to schema nodes with full fidelity.
	if (html && hasSemanticHtml(html)) {
		return false;
	}

	if (!text) return false;

	// Only intercept if the plain text actually contains Markdown syntax.
	// Plain text without Markdown formatting falls through to ProseMirror's
	// native paste handler for optimal caret, selection, and undo behavior.
	if (!hasMarkdownSyntax(text)) {
		return false;
	}

	const blocks = markdownToTiptapDoc(text).content ?? [];
	if (blocks.length === 0) return false;

	return editor.commands.insertContent(inlineIfSingleParagraph(blocks));
}

// A single-paragraph paste (the common case -- a sentence, a link, a bolded
// phrase) merges into the surrounding paragraph. Inserting the paragraph
// node itself mid-sentence would nest a paragraph inside a paragraph, which
// the schema rejects.
function inlineIfSingleParagraph(blocks: JSONContent[]): JSONContent[] {
	if (blocks.length === 1 && blocks[0]?.type === "paragraph") {
		return blocks[0].content ?? [];
	}
	return blocks;
}
