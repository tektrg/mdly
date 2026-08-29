import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { TextAnchor } from "./types.js";

const CONTEXT_LENGTH = 40;

/**
 * Builds a quote+context anchor (D1's "quote" mode) directly from the live
 * ProseMirror doc's own text, not the host's flattened-markdown string --
 * `doc.textBetween` is exact for any selection regardless of how PM
 * positions line up with a separately-flattened text representation, so this
 * sidesteps needing a PM-position-to-flattened-offset translation layer.
 *
 * Never produces a "revision" mode anchor: that requires knowing the
 * document's current saved revision id, which is desktop-main-process state
 * (doc-history) the kit has no access to. New threads opened from this UI
 * are always quote+context; revision-mode anchors, if ever produced, would
 * come from a future host-side upgrade of `onOpenThread`'s handling in
 * Slice 3, not from here.
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
