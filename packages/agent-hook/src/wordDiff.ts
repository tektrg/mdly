import { diffWordsWithSpace } from "diff";

/**
 * One word-level change between two texts: the `before` text at
 * `[start, end)` of the old text is replaced by `after`. A pure insertion has
 * `start === end`; a pure deletion has `after === ""`.
 */
export interface WordChange {
	start: number;
	end: number;
	before: string;
	after: string;
}

/**
 * Word-level changes from `oldText` to `newText`. Adjacent removed/added
 * parts merge into one change, so "the quick fox" → "the slow fox" is one
 * change (quick → slow), not a deletion plus an insertion.
 */
export function wordChanges(oldText: string, newText: string): WordChange[] {
	const changes: WordChange[] = [];
	let offset = 0;
	let open: WordChange | null = null;
	for (const part of diffWordsWithSpace(oldText, newText)) {
		if (!part.added && !part.removed) {
			if (open) changes.push(open);
			open = null;
			offset += part.value.length;
			continue;
		}
		if (!open) open = { start: offset, end: offset, before: "", after: "" };
		if (part.removed) {
			open.before += part.value;
			offset += part.value.length;
			open.end = offset;
		} else {
			open.after += part.value;
		}
	}
	if (open) changes.push(open);
	return changes;
}

/** Applies `changes` (as produced by `wordChanges`) to `oldText`. */
export function applyWordChanges(
	oldText: string,
	changes: WordChange[],
): string {
	let out = "";
	let cursor = 0;
	for (const change of [...changes].sort((a, b) => a.start - b.start)) {
		out += oldText.slice(cursor, change.start) + change.after;
		cursor = change.end;
	}
	return out + oldText.slice(cursor);
}

/**
 * A compact, human- and agent-readable diff: unchanged words kept,
 * removed words as `[-old-]`, new words as `{+new+}` (git's --word-diff=plain
 * format). Long unchanged runs collapse to `…` around the changes.
 */
export function formatWordDiff(
	oldText: string,
	newText: string,
	contextChars = 60,
): string {
	const changes = wordChanges(oldText, newText);
	if (changes.length === 0) return "";
	let out = "";
	let cursor = 0;
	for (const change of changes) {
		const gap = oldText.slice(cursor, change.start);
		if (cursor === 0) {
			out += gap.length > contextChars ? `…${gap.slice(-contextChars)}` : gap;
		} else if (gap.length > contextChars * 2) {
			out += `${gap.slice(0, contextChars)}\n…\n${gap.slice(-contextChars)}`;
		} else {
			out += gap;
		}
		if (change.before) out += `[-${change.before}-]`;
		if (change.after) out += `{+${change.after}+}`;
		cursor = change.end;
	}
	const tail = oldText.slice(cursor);
	out += tail.length > contextChars ? `${tail.slice(0, contextChars)}…` : tail;
	return out;
}
