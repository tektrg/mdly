// Turns user input (the `/embed` prompt, clipboard HTML) into iframe embed
// nodes through the same Markdown parse rules used when a file is opened, so
// pasted/typed embeds can never accept a src a saved file would reject.

import type { JSONContent } from "@tiptap/core";
import { isRemoteIframeSrc } from "./IframeEmbed.js";
import { markdownToTiptapDoc } from "./markdownToProsemirror.js";

export type EmbedInputResult =
	| { ok: true; attrs: Record<string, unknown> }
	| { ok: false; error: string };

const IFRAME_TAG = /<iframe\b[^>]*>(?:\s*<\/iframe\s*>)?/gi;

/**
 * Accepts either full `<iframe …>` code (kept byte-identical) or a bare
 * `https:` URL, which is wrapped as
 * `<iframe src="URL" width="100%" height="480"></iframe>`.
 */
export function parseEmbedInput(input: string): EmbedInputResult {
	const trimmed = input.trim();
	if (!trimmed)
		return { ok: false, error: "Paste iframe code or an https:// URL." };
	let raw = trimmed;
	if (!/^<iframe\b/i.test(trimmed)) {
		if (/^http:\/\//i.test(trimmed)) {
			return { ok: false, error: "Only https:// URLs can be embedded." };
		}
		if (!isRemoteIframeSrc(trimmed) || /\s/.test(trimmed)) {
			return { ok: false, error: "Paste iframe code or an https:// URL." };
		}
		const escaped = trimmed.split("&").join("&amp;").split('"').join("&quot;");
		raw = `<iframe src="${escaped}" width="100%" height="480"></iframe>`;
	}
	const embed = singleEmbed(raw);
	if (!embed) {
		return {
			ok: false,
			error: "Iframe src must be https:// or a local .html file.",
		};
	}
	return { ok: true, attrs: embed.attrs ?? {} };
}

/**
 * Clipboard HTML that is nothing but `<iframe>` elements (e.g. a copied embed
 * snippet) → the iframe Markdown, one per block. Null when the HTML has other
 * visible text or no iframe parses to a valid embed.
 */
export function extractIframeEmbedMarkdown(html: string): string | null {
	const tags = html.match(IFRAME_TAG);
	if (!tags) return null;
	const leftover = html
		.replace(IFRAME_TAG, "")
		.replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, "")
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ")
		.trim();
	if (leftover) return null;
	const valid = tags.map((tag) => tag.trim()).filter((tag) => singleEmbed(tag));
	return valid.length > 0 ? valid.join("\n\n") : null;
}

function singleEmbed(raw: string): JSONContent | null {
	const blocks = markdownToTiptapDoc(raw).content ?? [];
	if (blocks.length !== 1 || blocks[0]?.type !== "embed") return null;
	return blocks[0];
}
