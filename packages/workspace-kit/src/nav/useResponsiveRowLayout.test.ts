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

import { compactMetaGap } from "./useResponsiveRowLayout";
describe("compactMetaGap", () => {
	it("ramps from 0 to ~19px over the 160px before the breakpoint", () => {
		expect(compactMetaGap(200, 420)).toBe(0);
		expect(compactMetaGap(260, 420)).toBe(0);
		expect(compactMetaGap(340, 420)).toBe(9.6);
		expect(compactMetaGap(500, 420)).toBe(19.2);
		expect(compactMetaGap(500, Infinity)).toBe(0);
	});
});
