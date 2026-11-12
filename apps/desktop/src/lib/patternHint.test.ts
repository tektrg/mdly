import { describe, expect, it } from "vitest";
import { invalidPatternEntries, livePatternMode } from "./patternHint";

describe("pattern hints (invalid regex feedback)", () => {
	it("lists regex entries that do not compile", () => {
		expect(invalidPatternEntries("memory/*, /(oops/")).toEqual(["/(oops/"]);
		expect(invalidPatternEntries("/[a-/")).toEqual(["/[a-/"]);
		expect(invalidPatternEntries("memory/*, *spec*.md, /^notes/")).toEqual([]);
		expect(invalidPatternEntries("")).toEqual([]);
	});

	it("live box: plain text stays plain; * or /…/ is pattern mode, flagged when invalid", () => {
		expect(livePatternMode("spec")).toBe("plain");
		expect(livePatternMode("*spec*")).toBe("pattern");
		expect(livePatternMode("/^mem/")).toBe("pattern");
		expect(livePatternMode("/(bad/")).toBe("invalid");
	});
});
