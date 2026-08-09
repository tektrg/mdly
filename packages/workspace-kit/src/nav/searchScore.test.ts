import { describe, expect, it } from "vitest";
import { isSubsequence, normalizeSearchText, scoreText } from "./searchScore";

describe("normalizeSearchText", () => {
	it("folds case and drops every separator", () => {
		expect(normalizeSearchText("My_Project - Notes.md")).toBe(
			"myprojectnotesmd",
		);
		expect(normalizeSearchText("notes/2026/Team Sync.md")).toBe(
			"notes2026teamsyncmd",
		);
		expect(normalizeSearchText("windows\\style\\path")).toBe(
			"windowsstylepath",
		);
	});
});

describe("scoreText", () => {
	it("ranks by how directly the needle matches, capped by the field's ceiling", () => {
		expect(scoreText("meeting", "meeting", 100)).toBe(100); // exact
		expect(scoreText("meetingnotes", "meeting", 100)).toBe(90); // prefix
		expect(scoreText("teammeetingnotes", "meeting", 100)).toBe(72); // substring
		expect(scoreText("meeting", "mtg", 100)).toBe(45); // subsequence
		expect(scoreText("meeting", "zzz", 100)).toBe(0); // no match
	});

	it("keeps a weak field below a strong one at every tier", () => {
		// A perfect match on the absolute path (ceiling 35) must still lose to a
		// merely-scattered match on the file name (ceiling 100).
		expect(scoreText("aboringpath", "aboringpath", 35)).toBeLessThan(
			scoreText("meeting", "mtg", 100),
		);
	});

	it("scores nothing when either side is empty", () => {
		expect(scoreText("", "meeting", 100)).toBe(0);
		expect(scoreText("meeting", "", 100)).toBe(0);
	});

	/**
	 * mdly's original scorer had a fifth tier between prefix and substring:
	 * `haystack.split("/").some((part) => part.startsWith(needle))`. It was
	 * unreachable -- every caller normalizes the haystack first, and
	 * `normalizeSearchText` strips `/`, so the split always yields one segment
	 * and the tier can only repeat the prefix check above it. Verified by brute
	 * force over ~6M normalized haystack/needle pairs: it decided the score zero
	 * times. It is not ported here; this test pins the behaviour it would have
	 * changed, so the omission stays deliberate rather than looking like a bug.
	 */
	it("does not treat path segments specially -- separators are gone by now", () => {
		const haystack = normalizeSearchText("notes/team/sync.md");

		expect(haystack).toBe("notesteamsyncmd");
		// "team" begins a path segment, but scores as a plain substring (-28),
		// not as a segment prefix (-16).
		expect(scoreText(haystack, "team", 100)).toBe(72);
	});
});

describe("isSubsequence", () => {
	it("requires the characters in order, not adjacent", () => {
		expect(isSubsequence("mtg", "meeting")).toBe(true);
		expect(isSubsequence("gtm", "meeting")).toBe(false);
		expect(isSubsequence("meeting", "meet")).toBe(false);
	});
});
