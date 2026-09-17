// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
	dropSlotIndex,
	evenSlotEdges,
	HANDLE_DRAG_CLICK_THRESHOLD_PX,
	moveTargetIndex,
} from "./tableGeometry.js";

describe("dropSlotIndex", () => {
	it("QB7: maps pointer offsets to insert-before slots", () => {
		// Three 100px columns: edges at 0, 100, 200, 300.
		const edges = [0, 100, 200, 300];
		expect(dropSlotIndex(edges, -10)).toBe(0);
		expect(dropSlotIndex(edges, 0)).toBe(0);
		expect(dropSlotIndex(edges, 50)).toBe(0);
		expect(dropSlotIndex(edges, 100)).toBe(1);
		expect(dropSlotIndex(edges, 250)).toBe(2);
		expect(dropSlotIndex(edges, 300)).toBe(3);
		expect(dropSlotIndex(edges, 999)).toBe(3);
	});

	it("an empty edge list is slot 0, never negative", () => {
		expect(dropSlotIndex([], 50)).toBe(0);
		expect(dropSlotIndex([0], 50)).toBe(0);
	});
});

describe("moveTargetIndex", () => {
	it("O2: dragging column 0 to the far end lands at the last index", () => {
		expect(moveTargetIndex(0, 3, 3)).toBe(2);
	});

	it("O3: dragging the last body row above the first lands at index 0", () => {
		expect(moveTargetIndex(2, 0, 3)).toBe(0);
	});

	it("O6/EC6: a drop back at the origin returns the origin (caller writes nothing)", () => {
		expect(moveTargetIndex(1, 1, 3)).toBe(1);
		expect(moveTargetIndex(1, 2, 3)).toBe(1);
	});

	it("clamps wild slots into range instead of throwing", () => {
		expect(moveTargetIndex(0, 99, 3)).toBe(2);
		expect(moveTargetIndex(2, -5, 3)).toBe(0);
	});
});

describe("evenSlotEdges", () => {
	it("splits the extent into equal slots with 0 first", () => {
		expect(evenSlotEdges(3, 300)).toEqual([0, 100, 200, 300]);
	});

	it("degenerate inputs still give a single slot", () => {
		expect(evenSlotEdges(0, 300)).toEqual([0]);
		expect(evenSlotEdges(3, 0)).toEqual([0]);
	});

	it("the click threshold is a small handful of pixels", () => {
		expect(HANDLE_DRAG_CLICK_THRESHOLD_PX).toBeGreaterThan(0);
		expect(HANDLE_DRAG_CLICK_THRESHOLD_PX).toBeLessThanOrEqual(8);
	});
});
