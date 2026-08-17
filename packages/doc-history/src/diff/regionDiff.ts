import { diffLines } from "diff";

/**
 * A `diff` (jsdiff)-backed line-level region diff/merge primitive (R20).
 * Present for a future slice's review UI/CLI — Slice 1 ships it tested
 * standalone with no UI attached.
 */
export type DiffRegionType = "unchanged" | "added" | "removed";

export interface DiffRegion {
	type: DiffRegionType;
	/** Raw text for this region, including original line endings. */
	value: string;
}

/** Line-level diff between two Markdown strings, tagged unchanged/added/removed. */
export function diffRegions(oldText: string, newText: string): DiffRegion[] {
	return diffLines(oldText, newText).map((change) => ({
		type: change.added ? "added" : change.removed ? "removed" : "unchanged",
		value: change.value,
	}));
}

/**
 * Reconstructs the "accept every incoming change" result: unchanged and
 * added regions are kept, removed regions are dropped — reproducing
 * `newText` by construction, with no offset arithmetic.
 */
export function mergeAcceptingAllRegions(regions: DiffRegion[]): string {
	return regions
		.filter((region) => region.type !== "removed")
		.map((region) => region.value)
		.join("");
}
