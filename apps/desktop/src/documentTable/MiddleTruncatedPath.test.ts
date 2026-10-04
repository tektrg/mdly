import { describe, expect, it } from "vitest";
import { middleTruncationCandidates } from "./MiddleTruncatedPath";

describe("middleTruncationCandidates", () => {
	it("folds middle segments into … but keeps the slashes and ends", () => {
		expect(middleTruncationCandidates("skills/project/memory")).toEqual([
			"skills/project/memory",
			"skills/…/memory",
		]);
		expect(middleTruncationCandidates("a/b/c/d/e").pop()).toBe("a/…/e");
	});
	it("leaves short paths alone", () => {
		expect(middleTruncationCandidates("notes/x")).toEqual(["notes/x"]);
	});
});
