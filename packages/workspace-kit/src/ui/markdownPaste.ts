import type { Editor } from "@tiptap/core";
import type { JSONContent } from "@tiptap/react";
import { markdownToTiptapDoc } from "../engine/index.js";

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

	const text = event.clipboardData?.getData("text/plain");
	if (!text) return false;

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
