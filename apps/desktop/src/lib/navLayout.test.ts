import { describe, expect, it } from "vitest";
import {
	NAV_RAIL_MIN_WIDTH,
	PEEK_DOCUMENT_MIN_WIDTH,
	WINDOW_MIN_WIDTH,
	windowWidthWithFloor,
} from "./navLayout";

describe("navLayout", () => {
	it("derives the window floor from the two widths it is made of (A11)", () => {
		expect(WINDOW_MIN_WIDTH).toBe(PEEK_DOCUMENT_MIN_WIDTH + NAV_RAIL_MIN_WIDTH);
		expect(WINDOW_MIN_WIDTH).toBe(780);
	});

	it("keeps R13's readable document width and the narrowest list", () => {
		expect(PEEK_DOCUMENT_MIN_WIDTH).toBe(600);
		expect(NAV_RAIL_MIN_WIDTH).toBe(180);
	});
});

describe("windowWidthWithFloor", () => {
	it("raises a width saved before the floor existed", () => {
		expect(windowWidthWithFloor(640)).toBe(WINDOW_MIN_WIDTH);
	});

	it("leaves a width at or above the floor untouched", () => {
		expect(windowWidthWithFloor(WINDOW_MIN_WIDTH)).toBe(WINDOW_MIN_WIDTH);
		expect(windowWidthWithFloor(1600)).toBe(1600);
	});
});
