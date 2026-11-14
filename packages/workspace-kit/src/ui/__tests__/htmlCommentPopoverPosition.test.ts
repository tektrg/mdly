import { describe, expect, it } from "vitest";
import { placeNotePopover } from "../htmlCommentPopoverPosition";

const bounds = { left: 0, top: 0, right: 800, bottom: 600 };
const size = { width: 300, height: 120 };
const at = (x: number, y: number) => ({
	left: x,
	top: y,
	right: x + 6,
	bottom: y + 6,
});

describe("placeNotePopover", () => {
	it("opens below and to the right by default", () => {
		const p = placeNotePopover(at(100, 100), size, bounds);
		expect(p).toEqual({ left: 92, top: 112, placement: "below" });
	});
	it("near the right edge expands to the left", () => {
		const p = placeNotePopover(at(700, 100), size, bounds);
		// Right edge aligns just past the marker, body extends leftwards.
		expect(p.left).toBe(700 + 6 + 8 - 300);
		const edge = placeNotePopover(at(790, 100), size, bounds);
		expect(edge.left + size.width).toBeLessThanOrEqual(792);
	});
	it("near the left edge clamps inside", () => {
		expect(placeNotePopover(at(2, 100), size, bounds).left).toBe(8);
	});
	it("near the bottom flips up", () => {
		const p = placeNotePopover(at(100, 560), size, bounds);
		expect(p.placement).toBe("above");
		expect(p.top).toBe(560 - 6 - 120);
	});
	it("near the top stays below", () => {
		expect(placeNotePopover(at(100, 2), size, bounds).placement).toBe("below");
	});
	it("respects an offset editor column", () => {
		const col = { left: 200, top: 50, right: 500, bottom: 400 };
		const p = placeNotePopover(at(480, 380), { width: 250, height: 100 }, col);
		expect(p.left).toBeGreaterThanOrEqual(208);
		expect(p.left + 250).toBeLessThanOrEqual(492);
		expect(p.placement).toBe("above");
	});
});
