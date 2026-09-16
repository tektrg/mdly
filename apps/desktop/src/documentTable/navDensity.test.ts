import { describe, expect, it } from "vitest";
import {
	NAV_RAIL_MIN_WIDTH,
	PEEK_DOCUMENT_MIN_WIDTH,
	WINDOW_MIN_WIDTH,
} from "../lib/navLayout";
import {
	COLUMN_PRIORITY,
	clampPeekListWidth,
	columnsForTier,
	densityTier,
	NAV_INDENT_MAX_LEVELS,
	navIndentRem,
} from "./navDensity";

describe("densityTier (R9, EC-19/EC-20)", () => {
	it("walks Rail -> List -> Card -> Table at the documented thresholds", () => {
		expect(densityTier(180)).toBe("rail");
		expect(densityTier(259)).toBe("rail");
		expect(densityTier(260)).toBe("list");
		expect(densityTier(399)).toBe("list");
		expect(densityTier(400)).toBe("card");
		expect(densityTier(559)).toBe("card");
		expect(densityTier(560)).toBe("table");
		expect(densityTier(1600)).toBe("table");
	});

	it("never reads a window width, so an identical container gives an identical tier", () => {
		// EC-20 in pure form: the function takes one number and there is no other
		// input a 920px and a 1600px window could differ on.
		expect(densityTier(300)).toBe(densityTier(300));
		expect(densityTier.length).toBe(1);
	});

	it("degrades to Rail rather than throwing on a zero or negative width", () => {
		expect(densityTier(0)).toBe("rail");
		expect(densityTier(-40)).toBe("rail");
	});
});

describe("columnsForTier (R9, EC-21)", () => {
	it("gives each tier a PREFIX of the one column-priority order", () => {
		expect(columnsForTier("rail")).toEqual(["name"]);
		expect(columnsForTier("list")).toEqual(["name", "modified"]);
		expect(columnsForTier("card")).toEqual([
			"name",
			"modified",
			"folder",
			"tags",
		]);
		expect(columnsForTier("table")).toEqual([
			"name",
			"modified",
			"folder",
			"tags",
		]);
	});

	it("never introduces a field a narrower tier did not already have", () => {
		const ladder = (["rail", "list", "card", "table"] as const).map(
			columnsForTier,
		);
		ladder.forEach((wider, index) => {
			const narrower = index === 0 ? [] : ladder[index - 1];
			expect(wider.slice(0, narrower.length)).toEqual(narrower);
		});
		expect(ladder[ladder.length - 1]).toEqual([...COLUMN_PRIORITY]);
	});
});

describe("navIndentRem (A10, EC-45/EC-96)", () => {
	it("grows per level up to the ceiling and then stops", () => {
		expect(navIndentRem(0)).toBeCloseTo(0.5);
		expect(navIndentRem(1)).toBeCloseTo(1.25);
		expect(navIndentRem(4)).toBeCloseTo(3.5);
		expect(navIndentRem(7)).toBeCloseTo(3.5);
		expect(navIndentRem(40)).toBe(navIndentRem(NAV_INDENT_MAX_LEVELS));
	});

	it("takes depth ONLY -- the ceiling is a constant, not per-tier config", () => {
		expect(navIndentRem.length).toBe(1);
		expect(NAV_INDENT_MAX_LEVELS).toBe(4);
	});
});

describe("clampPeekListWidth (R13, EC-28..EC-31, EC-69)", () => {
	it("passes the desired width through when the document still fits", () => {
		expect(
			clampPeekListWidth({ availableWidth: 1400, desiredWidth: 500 }),
		).toEqual({ listWidth: 500, documentWidth: 900, outcome: "desired" });
	});

	it("cannot push the document under its readable minimum (EC-28)", () => {
		const split = clampPeekListWidth({
			availableWidth: 1000,
			desiredWidth: 900,
		});
		expect(split.listWidth).toBe(400);
		expect(split.documentWidth).toBe(PEEK_DOCUMENT_MIN_WIDTH);
		expect(split.outcome).toBe("clamped");
	});

	it("re-clamps on shrink and restores the SAME desired width on widen (EC-29/EC-30)", () => {
		const desiredWidth = 500;
		expect(
			clampPeekListWidth({ availableWidth: 1000, desiredWidth }).listWidth,
		).toBe(400);
		// Nothing was written back, so widening hands the user their own choice.
		expect(
			clampPeekListWidth({ availableWidth: 1400, desiredWidth }).listWidth,
		).toBe(desiredWidth);
	});

	it("never lets the list fall below the rail minimum", () => {
		expect(
			clampPeekListWidth({ availableWidth: 1400, desiredWidth: 40 }).listWidth,
		).toBe(NAV_RAIL_MIN_WIDTH);
	});

	it("NAMES the degenerate outcome below the window floor, never zero or negative (EC-69)", () => {
		const split = clampPeekListWidth({
			availableWidth: WINDOW_MIN_WIDTH - 100,
			desiredWidth: 400,
		});
		expect(split.outcome).toBe("degenerate");
		expect(split.listWidth).toBe(NAV_RAIL_MIN_WIDTH);
		expect(split.documentWidth).toBe(
			WINDOW_MIN_WIDTH - 100 - NAV_RAIL_MIN_WIDTH,
		);
		expect(split.documentWidth).toBeGreaterThan(0);
	});

	it("still returns a non-negative document width at an absurd zero split", () => {
		const split = clampPeekListWidth({ availableWidth: 0, desiredWidth: 400 });
		expect(split.outcome).toBe("degenerate");
		expect(split.listWidth).toBe(NAV_RAIL_MIN_WIDTH);
		expect(split.documentWidth).toBe(0);
	});

	it("is exactly at the boundary at the window floor itself (A11)", () => {
		const split = clampPeekListWidth({
			availableWidth: WINDOW_MIN_WIDTH,
			desiredWidth: 400,
		});
		expect(split.outcome).toBe("clamped");
		expect(split.listWidth).toBe(NAV_RAIL_MIN_WIDTH);
		expect(split.documentWidth).toBe(PEEK_DOCUMENT_MIN_WIDTH);
	});
});
