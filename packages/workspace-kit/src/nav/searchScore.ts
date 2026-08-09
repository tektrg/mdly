/**
 * Relevance scoring for file search, shared by every surface in the family
 * that ranks files by a typed query -- the kit's own Search page and mdly's
 * command palette (`apps/desktop/src/lib/fileSearch.ts`, which imports from
 * here). One implementation so the two can never start feeling different.
 *
 * Kept free of React, the DOM, and any file/workspace type so it can be
 * imported from `@mdly/workspace-kit/search` without pulling the UI barrel in.
 */

/**
 * Case- and separator-insensitive form of a string, for matching only -- never
 * for display. Collapsing spaces, underscores, hyphens, dots and slashes away
 * is what lets `myproject` find `My Project.md` and `notesagent` find
 * `notes/Agent Search.md`.
 */
export function normalizeSearchText(value: string): string {
	return value.toLocaleLowerCase().replace(/[\s_\-./\\]+/g, "");
}

/**
 * Tiered relevance of one haystack against one needle, both already run
 * through `normalizeSearchText`. Returns 0 for no match.
 *
 * `exactScore` is the ceiling for this haystack. Callers pass a lower ceiling
 * for weaker fields (a full path scores below a file name), so a perfect match
 * on a weak field can never outrank a perfect match on a strong one.
 */
export function scoreText(
	haystack: string,
	needle: string,
	exactScore: number,
): number {
	if (!haystack || !needle) return 0;
	if (haystack === needle) return exactScore;
	if (haystack.startsWith(needle)) return exactScore - 10;
	if (haystack.includes(needle)) return exactScore - 28;
	if (isSubsequence(needle, haystack)) return exactScore - 55;
	return 0;
}

/**
 * True when `needle`'s characters all appear in `haystack` in order, not
 * necessarily adjacent -- the loosest tier, which is what lets `mtg` find
 * `meeting`.
 */
export function isSubsequence(needle: string, haystack: string): boolean {
	let index = 0;
	for (const char of haystack) {
		if (char === needle[index]) index += 1;
		if (index === needle.length) return true;
	}
	return false;
}
