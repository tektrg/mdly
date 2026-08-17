import { describe, expect, it } from "vitest";
import { diffRegions, mergeAcceptingAllRegions } from "./regionDiff.js";

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
