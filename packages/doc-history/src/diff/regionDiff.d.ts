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
export declare function diffRegions(oldText: string, newText: string): DiffRegion[];
/**
 * Reconstructs the "accept every incoming change" result: unchanged and
 * added regions are kept, removed regions are dropped — reproducing
 * `newText` by construction, with no offset arithmetic.
 */
export declare function mergeAcceptingAllRegions(regions: DiffRegion[]): string;
/** A passthrough span of text present unchanged in both old and new text (R2). */
export interface UnchangedGroup {
    kind: "unchanged";
    id: string;
    value: string;
}
/**
 * A reviewable unit pairing an adjacent removed+added run (R2, R3, R4):
 * `oldText` is what was there before, `newText` is the incoming replacement.
 * Either side may be empty (a pure insertion or pure deletion).
 */
export interface ChangedGroup {
    kind: "changed";
    id: string;
    oldText: string;
    newText: string;
}
export type ChangeGroup = UnchangedGroup | ChangedGroup;
/**
 * Groups the flat `diffRegions()` output into reviewable units: each
 * `unchanged` region becomes its own passthrough group, and each maximal run
 * of adjacent `removed`/`added` regions is collapsed into one `changed`
 * group (oldText = concatenated removed text, newText = concatenated added
 * text). Group ids are assigned by position, so they're stable and
 * deterministic for a given (oldText, newText) pair and safe to key a
 * decision map on (R3, R4, R5).
 *
 * Handles 3+ changed groups (each separated by an unchanged region becomes
 * its own group) and the empty-string edge cases: diffing "" against
 * non-empty text (or vice versa) yields a single changed group with one side
 * empty, never a crash (R25).
 */
export declare function groupChangeRegions(oldText: string, newText: string): ChangeGroup[];
/** Per-group decision keyed by `ChangeGroup.id`. */
export type ChangeGroupDecisions = Record<string, "accept" | "reject">;
/**
 * Merges `groupChangeRegions()` output using a per-group accept/reject
 * decision map. Unchanged groups always pass through untouched. A changed
 * group takes its `newText` when decided `"accept"`, its `oldText` when
 * decided `"reject"` — and a group with NO entry in `decisions` defaults to
 * `"accept"` (R5: unreviewed regions behave as if this feature didn't exist,
 * so the external edit wins). Built by walking groups and concatenating, so
 * the result is correct by construction with no offset arithmetic (R6).
 */
export declare function mergeSelectedRegions(groups: ChangeGroup[], decisions: ChangeGroupDecisions): string;
//# sourceMappingURL=regionDiff.d.ts.map