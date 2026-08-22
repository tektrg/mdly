import { describe, expect, it } from "vitest";
import type { ChangeGroupDecisions } from "./regionDiff.js";
import {
	diffRegions,
	groupChangeRegions,
	mergeAcceptingAllRegions,
	mergeSelectedRegions,
} from "./regionDiff.js";

describe("diffRegions (R20)", () => {
	it("tags regions unchanged/added/removed for two strings differing by one paragraph", () => {
		const oldText = "Intro line\n\nOld paragraph.\n\nOutro line\n";
		const newText = "Intro line\n\nNew paragraph.\n\nOutro line\n";

		const regions = diffRegions(oldText, newText);
		expect(
			regions.some(
				(r) => r.type === "removed" && r.value.includes("Old paragraph."),
			),
		).toBe(true);
		expect(
			regions.some(
				(r) => r.type === "added" && r.value.includes("New paragraph."),
			),
		).toBe(true);
		expect(
			regions.some(
				(r) => r.type === "unchanged" && r.value.includes("Intro line"),
			),
		).toBe(true);
	});

	it("matches the expected line-level diff on a known small input", () => {
		const regions = diffRegions("a\nb\nc\n", "a\nx\nc\n");
		expect(regions.map((r) => r.type)).toEqual([
			"unchanged",
			"removed",
			"added",
			"unchanged",
		]);
	});
});

describe("mergeAcceptingAllRegions (R20)", () => {
	it("reproduces the new text exactly by accepting every incoming change", () => {
		const oldText = "line one\nline two\nline three\n";
		const newText = "line one\nline TWO changed\nline three\nline four\n";

		const regions = diffRegions(oldText, newText);
		expect(mergeAcceptingAllRegions(regions)).toBe(newText);
	});

	it("round-trips identical text with a single unchanged region", () => {
		const text = "no changes here\n";
		const regions = diffRegions(text, text);
		expect(regions).toEqual([{ type: "unchanged", value: text }]);
		expect(mergeAcceptingAllRegions(regions)).toBe(text);
	});
});

/** Fixture with 3 separately-changed regions, each bracketed by unchanged text. */
const THREE_REGION_OLD_TEXT =
	"line one\nOLD-A\nline three\nOLD-B\nline five\nOLD-C\nline seven\n";
const THREE_REGION_NEW_TEXT =
	"line one\nNEW-A\nline three\nNEW-B\nline five\nNEW-C\nline seven\n";

describe("groupChangeRegions (R2, R3, R4, R5)", () => {
	it("groups a 3-changed-region fixture into alternating unchanged/changed groups", () => {
		const groups = groupChangeRegions(
			THREE_REGION_OLD_TEXT,
			THREE_REGION_NEW_TEXT,
		);

		expect(groups.map((g) => g.kind)).toEqual([
			"unchanged",
			"changed",
			"unchanged",
			"changed",
			"unchanged",
			"changed",
			"unchanged",
		]);

		const changed = groups.filter((g) => g.kind === "changed");
		expect(changed.map((g) => [g.oldText, g.newText])).toEqual([
			["OLD-A\n", "NEW-A\n"],
			["OLD-B\n", "NEW-B\n"],
			["OLD-C\n", "NEW-C\n"],
		]);

		// ids are unique and stable/deterministic across a repeat call on the
		// same input.
		const ids = groups.map((g) => g.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(
			groupChangeRegions(THREE_REGION_OLD_TEXT, THREE_REGION_NEW_TEXT).map(
				(g) => g.id,
			),
		).toEqual(ids);
	});

	it("handles the empty-old-text edge case without crashing", () => {
		const groups = groupChangeRegions("", "some content");
		expect(groups).toEqual([
			{ kind: "changed", id: "group-0", oldText: "", newText: "some content" },
		]);
	});

	it("handles the empty-new-text edge case without crashing", () => {
		const groups = groupChangeRegions("original", "");
		expect(groups).toEqual([
			{ kind: "changed", id: "group-0", oldText: "original", newText: "" },
		]);
	});
});

describe("mergeSelectedRegions (R3, R4, R5, R6)", () => {
	it("merges a 3-changed-region fixture to the exact expected string for a mixed accept/reject map", () => {
		const groups = groupChangeRegions(
			THREE_REGION_OLD_TEXT,
			THREE_REGION_NEW_TEXT,
		);
		const changed = groups.filter((g) => g.kind === "changed");
		expect(changed).toHaveLength(3);

		// Accept A, reject B, leave C unset — R5 says unset defaults to accept.
		const decisions: ChangeGroupDecisions = {
			[changed[0].id]: "accept",
			[changed[1].id]: "reject",
		};

		const merged = mergeSelectedRegions(groups, decisions);
		expect(merged).toBe(
			"line one\nNEW-A\nline three\nOLD-B\nline five\nNEW-C\nline seven\n",
		);
	});

	it("reproduces the original oldText exactly when every changed region is rejected", () => {
		const groups = groupChangeRegions(
			THREE_REGION_OLD_TEXT,
			THREE_REGION_NEW_TEXT,
		);
		const decisions: ChangeGroupDecisions = {};
		for (const group of groups) {
			if (group.kind === "changed") {
				decisions[group.id] = "reject";
			}
		}

		expect(mergeSelectedRegions(groups, decisions)).toBe(THREE_REGION_OLD_TEXT);
	});

	it("matches mergeAcceptingAllRegions exactly when every changed region is accepted (no drift between the two code paths)", () => {
		const groups = groupChangeRegions(
			THREE_REGION_OLD_TEXT,
			THREE_REGION_NEW_TEXT,
		);
		const decisions: ChangeGroupDecisions = {};
		for (const group of groups) {
			if (group.kind === "changed") {
				decisions[group.id] = "accept";
			}
		}

		const viaSelectedRegions = mergeSelectedRegions(groups, decisions);
		const viaAcceptingAllRegions = mergeAcceptingAllRegions(
			diffRegions(THREE_REGION_OLD_TEXT, THREE_REGION_NEW_TEXT),
		);

		expect(viaSelectedRegions).toBe(viaAcceptingAllRegions);
		expect(viaSelectedRegions).toBe(THREE_REGION_NEW_TEXT);
	});

	it("does not crash on empty-string edges and merges to the correct empty/full string on all-accept and all-reject (R25)", () => {
		const emptyOldGroups = groupChangeRegions("", "some content");
		expect(
			mergeSelectedRegions(emptyOldGroups, {
				[emptyOldGroups[0].id]: "accept",
			}),
		).toBe("some content");
		expect(
			mergeSelectedRegions(emptyOldGroups, {
				[emptyOldGroups[0].id]: "reject",
			}),
		).toBe("");

		const emptyNewGroups = groupChangeRegions("original", "");
		expect(
			mergeSelectedRegions(emptyNewGroups, {
				[emptyNewGroups[0].id]: "accept",
			}),
		).toBe("");
		expect(
			mergeSelectedRegions(emptyNewGroups, {
				[emptyNewGroups[0].id]: "reject",
			}),
		).toBe("original");
	});

	it("reproduces a Markdown table byte-for-byte when the region straddling it is rejected (R6, O5)", () => {
		const oldText = [
			"# Notes",
			"",
			"| Name | Value |",
			"| --- | --- |",
			"| Alpha | 1 |",
			"| Beta | 2 |",
			"| Gamma | 3 |",
			"",
			"End of doc.",
			"",
		].join("\n");
		const newText = oldText.replace("| Beta | 2 |", "| Beta | 99 |");

		const groups = groupChangeRegions(oldText, newText);
		const changed = groups.filter((g) => g.kind === "changed");
		expect(changed).toHaveLength(1);
		expect(changed[0].oldText).toBe("| Beta | 2 |\n");
		expect(changed[0].newText).toBe("| Beta | 99 |\n");

		const merged = mergeSelectedRegions(groups, { [changed[0].id]: "reject" });
		expect(merged).toBe(oldText);
	});
});
