import { describe, expect, it } from "vitest";
import {
	NAV_RAIL_MIN_WIDTH,
	PEEK_DOCUMENT_MIN_WIDTH,
	WINDOW_MIN_WIDTH,
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
