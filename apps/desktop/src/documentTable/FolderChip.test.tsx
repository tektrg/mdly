import { describe, expect, it } from "vitest";
import { cardDates } from "./DocumentListRow";
import { lastFolderName } from "./FolderChip";

describe("lastFolderName", () => {
	it("keeps only the innermost folder", () => {
		expect(
			lastFolderName("command-bar-macos-paradee/.build/checkouts/x/src/sqlite"),
		).toBe("sqlite");
		expect(lastFolderName("briefs")).toBe("briefs");
		expect(lastFolderName("a\\b\\c")).toBe("c");
		expect(lastFolderName("a/b/")).toBe("b");
	});

	it("is empty for the workspace root", () => {
		expect(lastFolderName("—")).toBe("");
		expect(lastFolderName("")).toBe("");
	});
});

describe("cardDates", () => {
	const now = new Date(2026, 10, 3, 23, 0);
	const at = Math.floor(new Date(2026, 10, 3, 22, 57).getTime() / 1000);
	it("dedupes identical created/modified labels into one", () => {
		const dates = cardDates(
			{ modifiedAt: at, createdAt: at },
			["modified", "created"],
			now,
		);
		expect(dates).toHaveLength(1);
		expect(dates[0].column).toBe("modified");
		expect(dates[0].title).toMatch(/^Modified .*\nCreated /);
	});
	it("keeps both, in column order, when they differ", () => {
		const earlier = at - 86_400 * 30;
		const dates = cardDates(
			{ modifiedAt: at, createdAt: earlier },
			["created", "modified"],
			now,
		);
		expect(dates.map((d) => d.column)).toEqual(["created", "modified"]);
	});
});
