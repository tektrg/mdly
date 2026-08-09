import { describe, expect, it } from "vitest";
import { buildTagCounts } from "./buildTagCounts";
import type { SidebarFile } from "./useSidebarTree";

describe("buildTagCounts", () => {
	it("counts how many files carry each tag", () => {
		const files: SidebarFile[] = [
			{ path: "a.md", tags: ["meeting", "work"] },
			{ path: "b.md", tags: ["work"] },
			{ path: "c.md", tags: ["work"] },
		];

		expect(buildTagCounts(files)).toEqual([
			{ name: "work", count: 3 },
			{ name: "meeting", count: 1 },
		]);
	});

	it("sorts by count descending, then name ascending for stable ties", () => {
		const files: SidebarFile[] = [
			{ path: "a.md", tags: ["zebra", "apple", "rare"] },
			{ path: "b.md", tags: ["zebra", "apple"] },
		];

		expect(buildTagCounts(files).map((tag) => tag.name)).toEqual([
			"apple",
			"zebra",
			"rare",
		]);
	});

	it("counts a tag once per file even when that file lists it twice", () => {
		const files: SidebarFile[] = [{ path: "a.md", tags: ["dup", "dup"] }];

		expect(buildTagCounts(files)).toEqual([{ name: "dup", count: 1 }]);
	});

	it("ignores files with no tags, and returns empty for none at all", () => {
		const files: SidebarFile[] = [
			{ path: "a.md" },
			{ path: "b.md", tags: [] },
			{ path: "c.md", tags: ["only"] },
		];

		expect(buildTagCounts(files)).toEqual([{ name: "only", count: 1 }]);
		expect(buildTagCounts([{ path: "a.md" }])).toEqual([]);
	});

	it("treats tag names verbatim -- no normalization, since rules differ per host", () => {
		const files: SidebarFile[] = [
			{ path: "a.md", tags: ["Work", "work", "type/meeting", "with space"] },
		];

		expect(
			buildTagCounts(files)
				.map((tag) => tag.name)
				.sort(),
		).toEqual(["Work", "type/meeting", "with space", "work"]);
	});

	it("does not mutate the input", () => {
		const tags = ["b", "a"];
		const files: SidebarFile[] = [{ path: "a.md", tags }];

		buildTagCounts(files);

		expect(tags).toEqual(["b", "a"]);
	});
});
