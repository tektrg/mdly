/** Longest heading kept as a card title; past it the text is cut. */
const MAX_HEADING_LENGTH = 200;

const OPENING_FENCE = /^﻿?---[ \t]*\r?\n/;
const CLOSING_FENCE = /\r?\n---[ \t]*(?:\r?\n|$)/;
const ATX_H1 = /^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** `text` without its leading front-matter block (an unclosed block is kept). */
export function stripFrontMatter(text: string): string {
	const opening = text.match(OPENING_FENCE);
	if (!opening) return text;
	const rest = text.slice(opening[0].length - 1);
	const closing = CLOSING_FENCE.exec(rest);
	if (!closing) return text;
	return rest.slice(closing.index + closing[0].length);
}

/**
 * The first `# H1` of a note's body (front matter and fenced code skipped),
 * with inline emphasis/code markers dropped; null when there is none.
 */
export function firstHeadingOf(text: string): string | null {
	let fence: string | null = null;
	for (const line of stripFrontMatter(text).split(/\r?\n/)) {
		const fenceMatch = line.match(CODE_FENCE);
		if (fenceMatch) {
			const marker = fenceMatch[1] ?? "";
			if (fence === null) fence = marker[0] ?? null;
			else if (marker[0] === fence) fence = null;
			continue;
		}
		if (fence !== null) continue;
		const heading = line.match(ATX_H1)?.[1];
		if (!heading) continue;
		const plain = heading.replace(/[*_`]+/g, "").trim();
		if (plain.length > 0) return plain.slice(0, MAX_HEADING_LENGTH);
	}
	return null;
}
