import { describe, expect, it } from "vitest";
import { springProgressSamples } from "./useResponsiveRowLayout";

describe("springProgressSamples", () => {
	it("starts at rest, rises monotonically without overshoot, ends at 1", () => {
		const s = springProgressSamples();
		expect(s[0]).toBe(0);
		expect(s[s.length - 1]).toBe(1);
		for (let i = 1; i < s.length; i++) {
			expect(s[i]).toBeGreaterThanOrEqual(s[i - 1]);
			expect(s[i]).toBeLessThanOrEqual(1);
		}
		// Slow start (from rest), then most travel by mid-duration.
		expect(s[1]).toBeLessThan(0.2);
		expect(s[Math.floor(s.length / 2)]).toBeGreaterThan(0.75);
	});
});
