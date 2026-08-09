import type { SidebarFile } from "./useSidebarTree";

export type SidebarTag = {
	name: string;
	count: number;
};

/**
 * Tallies the tags already attached to each file into `{ name, count }` rows,
 * sorted by count descending, then name ascending for stable ties.
 *
 * Deliberately dumb: it counts, and nothing else. It does not parse files, does
 * not normalize names, and does not know what a tag means -- those differ per
 * host app (frontmatter vs. an external registry; Obsidian-style lowercase
 * `a/b` hierarchies vs. arbitrary strings with spaces) and applying one app's
 * rules to the other's data would silently corrupt it. Hosts populate
 * `SidebarFile.tags`; the kit only aggregates.
 *
 * Each file contributes a given tag at most once, even if it lists it twice.
 *
 * Mirrors `buildRecentFilesList` -- a pure function over the same `files`
 * array that backs every sidebar page, testable without a DOM.
 */
export function buildTagCounts(files: readonly SidebarFile[]): SidebarTag[] {
	const counts = new Map<string, number>();
	for (const file of files) {
		if (!file.tags?.length) continue;
		const seen = new Set<string>();
		for (const tag of file.tags) {
			if (seen.has(tag)) continue;
			seen.add(tag);
			counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
	}
	return Array.from(counts, ([name, count]) => ({ name, count })).sort(
		(a, b) => b.count - a.count || a.name.localeCompare(b.name),
	);
}
