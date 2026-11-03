import { describe, expect, it } from "vitest";
import { recentFileDates } from "./RecentFilesList";

describe("recentFileDates", () => {
	it("shows one date when created and modified render the same", () => {
		const at = new Date(2026, 10, 3, 9, 0).getTime();
		const dates = recentFileDates(at, at + 60_000);
		expect(dates).toHaveLength(1);
		expect(dates[0].title).toContain("Created");
		expect(dates[0].title).toContain("Modified");
	});

	it("shows both, created first, when they differ", () => {
		const created = new Date(2026, 9, 1).getTime();
		const modified = new Date(2026, 10, 3).getTime();
		const dates = recentFileDates(created, modified);
		expect(dates.map((d) => d.key)).toEqual(["created", "modified"]);
		expect(dates[0].title.startsWith("Created ")).toBe(true);
		expect(dates[1].title.startsWith("Modified ")).toBe(true);
	});
});
