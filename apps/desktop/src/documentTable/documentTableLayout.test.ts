// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
	clampColumnWidth,
	gridTemplateFor,
	moveColumnOrder,
	normalizeColumnOrder,
	secondaryColumnFor,
} from "./documentTableLayout";

describe("documentTableLayout", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("never moves Name out of first place", () => {
		expect(moveColumnOrder(["name", "folder", "modified"], 1, 2)).toEqual([
			"name",
			"modified",
			"folder",
		]);
		expect(moveColumnOrder(["name", "folder", "modified"], 2, 1)).toEqual([
			"name",
			"modified",
			"folder",
		]);
		// Index 0 is pinned: moves from or to it are no-ops.
		expect(moveColumnOrder(["name", "folder", "modified"], 0, 2)).toEqual([
			"name",
			"folder",
			"modified",
		]);
		expect(moveColumnOrder(["name", "folder", "modified"], 1, 0)).toEqual([
			"name",
			"folder",
			"modified",
		]);
	});

	it("repairs stale saves back to a Name-first permutation", () => {
		expect(normalizeColumnOrder(["modified", "name"])).toEqual([
			"name",
			"modified",
			"folder",
			"created",
		]);
		expect(normalizeColumnOrder(["bogus"])).toEqual([
			"name",
			"folder",
			"modified",
			"created",
		]);
		expect(normalizeColumnOrder(null)).toEqual([
			"name",
			"folder",
			"modified",
			"created",
		]);
	});

	it("clamps resize drags to the usable band", () => {
		expect(clampColumnWidth(200)).toBe(200);
		expect(clampColumnWidth(10)).toBe(80);
		expect(clampColumnWidth(9999)).toBe(640);
		expect(clampColumnWidth(Number.NaN)).toBe(80);
	});

	it("leaves the Tailwind literal alone while the layout is stock", () => {
		expect(
			gridTemplateFor(["name", "folder", "modified", "created"], {}),
		).toBeUndefined();
	});

	it("emits per-column tracks in live order once customized", () => {
		expect(
			gridTemplateFor(["name", "modified", "folder"], { modified: 200 }),
		).toEqual({
			gridTemplateColumns: "minmax(0,1fr) 200px minmax(0,11rem)",
		});
	});

	it("picks the secondary line as the first data column in order", () => {
		expect(secondaryColumnFor(["name", "folder", "modified"])).toBe("folder");
		expect(secondaryColumnFor(["name", "modified", "folder"])).toBe("modified");
	});
});
