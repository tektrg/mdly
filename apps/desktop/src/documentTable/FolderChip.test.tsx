import { describe, expect, it } from "vitest";
import { cardDate } from "./DocumentListRow";
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

describe("cardDate", () => {
	const now = new Date(2026, 10, 3, 23, 0);
	const modified = Math.floor(new Date(2026, 10, 3, 22, 50).getTime() / 1000);
	const created = Math.floor(new Date(2026, 9, 29, 9, 12).getTime() / 1000);
	const row = { modifiedAt: modified, createdAt: created };
	it("shows modified by default and when sorting by modified", () => {
		expect(cardDate(row, undefined, now).field).toBe("modified");
		expect(cardDate(row, "modified", now).label).toBe("10:50 PM");
	});
	it("shows created when sorting by created", () => {
		const date = cardDate(row, "created", now);
		expect(date.field).toBe("created");
		expect(date.label).toBe("29 Oct");
	});
	it("tooltip lists both fields with full datetimes", () => {
		expect(cardDate(row, "name", now).title).toBe(
			"Modified  3 Nov 2026, 10:50 PM\nCreated   29 Oct 2026, 9:12 AM",
		);
	});
});
