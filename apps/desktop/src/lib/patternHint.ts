/**
 * UI feedback for TextPattern input: which typed entries are broken regexes
 * (they would silently match nothing), and which mode the live filter box is in.
 */
import { liveFilterPattern } from "../documentTable/documentTableEngine";
import { entryRegExp, isRegexEntry, splitEntries } from "./textPattern";

/** `/…/` entries in a typed list that do not compile. */
export function invalidPatternEntries(text: string): string[] {
	return splitEntries(text).filter(
		(entry) => isRegexEntry(entry) && entryRegExp(entry) === null,
	);
}

/** The Cmd+L box's mode for `query`, mirroring `liveFilterPattern`. */
export function livePatternMode(
	query: string,
): "plain" | "pattern" | "invalid" {
	if (!liveFilterPattern(query)) return "plain";
	return invalidPatternEntries(query).length > 0 ? "invalid" : "pattern";
}
