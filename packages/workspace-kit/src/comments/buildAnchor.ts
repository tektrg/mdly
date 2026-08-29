import type { JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
	hasLinkedNotionFrontMatter,
	normalizeNotionMarkdownBody,
	parseMarkdownFrontMatter,
	tiptapDocToMarkdown,
} from "../engine/index.js";
import type { TextAnchor } from "./types.js";

const CONTEXT_LENGTH = 40;

/**
 * Builds a quote+context anchor (D1's "quote" mode) directly from the live
 * ProseMirror doc's own text, not the host's flattened-markdown string --
 * `doc.textBetween` is exact for any selection regardless of how PM
 * positions line up with a separately-flattened text representation, so this
 * sidesteps needing a PM-position-to-flattened-offset translation layer.
 */
export function buildQuoteAnchor(
	doc: ProseMirrorNode,
	from: number,
	to: number,
): TextAnchor {
	const docSize = doc.content.size;
	return {
		from,
		to,
		quote: doc.textBetween(from, to, "\n"),
		mode: "quote",
		contextBefore: doc.textBetween(Math.max(0, from - CONTEXT_LENGTH), from, "\n"),
		contextAfter: doc.textBetween(to, Math.min(docSize, to + CONTEXT_LENGTH), "\n"),
	};
}

/** Strips a saved file's raw content down to the same BODY markdown a live editor's doc represents (front matter lives outside the tiptap doc -- mirrors EditorView's `bodyForEditor`). */
function extractBody(rawFileContent: string): string {
	const parsed = parseMarkdownFrontMatter(rawFileContent);
	if (parsed.type === "none") return parsed.body;
	return hasLinkedNotionFrontMatter(parsed.raw)
		? normalizeNotionMarkdownBody(parsed.body)
		: parsed.body;
}

/**
 * Builds a comment anchor for a brand-new thread, deciding D1's two modes at
 * comment time: `revision` when the live doc's serialized body is
 * byte-identical to the head revision's extracted body (the offset is then
 * valid against that saved revision by construction, per R10/R11), else
 * `quote` against the live draft. Falls back to quote mode whenever there is
 * no head revision yet, or its content can't be read (evicted/undownloaded).
 *
 * `getHeadRevisionId` is resolved fresh here rather than taking a snapshotted
 * id: the editor mints a new revision mid-session on its own (idle/forced
 * cuts), so a value cached at mount would go stale and silently under-use
 * revision mode for the rest of the session.
 */
export async function buildCommentAnchor(
	doc: ProseMirrorNode,
	from: number,
	to: number,
	revisionContext: {
		getHeadRevisionId: () => Promise<string | null>;
		readRevisionContent: (revisionId: string) => Promise<string | null>;
	} | null,
): Promise<TextAnchor> {
	const quoteAnchor = buildQuoteAnchor(doc, from, to);
	if (!revisionContext) return quoteAnchor;

	const headRevisionId = await revisionContext.getHeadRevisionId();
	if (!headRevisionId) return quoteAnchor;

	const rawRevisionContent =
		await revisionContext.readRevisionContent(headRevisionId);
	if (rawRevisionContent === null) return quoteAnchor;

	const currentBody = tiptapDocToMarkdown(doc.toJSON() as JSONContent);
	if (extractBody(rawRevisionContent) !== currentBody) return quoteAnchor;

	return { ...quoteAnchor, mode: "revision", revisionId: headRevisionId };
}
