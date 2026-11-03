import { describe, expect, it } from "vitest";
import { formatFullDateTime, formatRowDate, rowDate } from "./dateLabels";

describe("rowDate", () => {
	const now = new Date(2026, 10, 3, 23, 0);
	const modified = new Date(2026, 10, 3, 22, 50).getTime();
	const created = new Date(2026, 9, 29, 9, 12).getTime();

	it("shows the modified date by default, as a time when today", () => {
		const d = rowDate(modified, created, undefined, now);
		expect(d.field).toBe("modified");
		expect(d.label).toBe("10:50 PM");
	});

	it("shows the created date when sorting by created", () => {
		const d = rowDate(modified, created, "created", now);
		expect(d.field).toBe("created");
		expect(d.label).toBe("29 Oct");
	});

	it("falls back to modified for non-date sorts", () => {
		expect(rowDate(modified, created, "name", now).field).toBe("modified");
	});

	it("tooltip names both fields with full datetimes", () => {
		expect(rowDate(modified, created, "created", now).title).toBe(
			"Modified  3 Nov 2026, 10:50 PM\nCreated   29 Oct 2026, 9:12 AM",
		);
	});

	it("tooltip omits Created when unknown", () => {
		expect(rowDate(modified, undefined, undefined, now).title).toBe(
			"Modified  3 Nov 2026, 10:50 PM",
		);
	});

	it("adds the year outside the current year", () => {
		expect(formatRowDate(new Date(2025, 0, 5).getTime(), now)).toBe(
			"5 Jan 2025",
		);
		expect(formatFullDateTime(new Date(2025, 0, 5, 0, 0).getTime())).toBe(
			"5 Jan 2025, 12:00 AM",
		);
	});
});
