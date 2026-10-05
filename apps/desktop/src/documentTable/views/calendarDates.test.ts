import { describe, expect, it } from "vitest";
import { calendarDayOf, moveValueToDay } from "./calendarDates";

const localDay = (ms: number) => {
	const at = new Date(ms);
	return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
};

describe("calendar dates", () => {
	it("files offset date-times on their local day, others on their written day", () => {
		const instant = "2026-10-05T23:30:00Z";
		expect(calendarDayOf(instant)).toBe(localDay(Date.parse(instant)));
		expect(calendarDayOf("2026-10-05T23:30:00+07:00")).toBe(
			localDay(Date.parse("2026-10-05T16:30:00Z")),
		);
		expect(calendarDayOf("2026-10-05T23:30:00")).toBe("2026-10-05");
		expect(calendarDayOf("2026-10-05")).toBe("2026-10-05");
		expect(calendarDayOf("soon")).toBeNull();
	});

	it("a move keeps the time part", () => {
		expect(moveValueToDay("2026-10-05", "2026-10-09")).toBe("2026-10-09");
		expect(moveValueToDay("2026-10-05T14:03:00", "2026-10-09")).toBe(
			"2026-10-09T14:03:00",
		);
		const moved = moveValueToDay("2026-10-05T14:03:00Z", "2026-10-09");
		expect(calendarDayOf(moved)).toBe("2026-10-09");
		const before = new Date("2026-10-05T14:03:00Z");
		const after = new Date(moved);
		expect([after.getHours(), after.getMinutes()]).toEqual([
			before.getHours(),
			before.getMinutes(),
		]);
	});
});
