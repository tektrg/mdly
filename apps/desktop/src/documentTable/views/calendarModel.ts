/**
 * Calendar layout as plain data: a month grid (whole weeks, Monday first) with
 * each note on the day its date field names. Dates are the scan's
 * `YYYY-MM-DD` strings, compared as text — no time zones involved.
 */

import type { DocumentTableRow } from "../documentTableView";
import {
	type PropertyField,
	type PropertyFieldId,
	propertyFieldId,
} from "../properties/propertyFields";
import { calendarDayOf } from "./calendarDates";

/** Notes listed per day cell before "+N more". */
export const CALENDAR_DAY_CARD_LIMIT = 3;

/** A month as year + zero-based month index. */
export type CalendarMonth = { year: number; month: number };

export type CalendarDay = {
	date: string;
	dayOfMonth: number;
	inMonth: boolean;
	/** Notes listed in the cell (capped). */
	rows: DocumentTableRow[];
	/** Every note on the day, for the "+N more" list. */
	allRows: DocumentTableRow[];
	total: number;
};

export type CalendarModel = {
	field: PropertyField;
	month: CalendarMonth;
	weeks: CalendarDay[][];
	/** Notes in the view whose date falls outside the shown grid. */
	outsideCount: number;
	/** Notes in the view with no date at all. */
	undatedCount: number;
};

/** The view's date field if still a date, else `due`, else the commonest date field. */
export function resolveCalendarField(
	fields: readonly PropertyField[],
	chosen: PropertyFieldId | null,
): PropertyField | null {
	const dates = fields.filter((field) => field.type === "date");
	return (
		dates.find((field) => field.id === chosen) ??
		dates.find((field) => field.id === propertyFieldId("due")) ??
		dates[0] ??
		null
	);
}

export function isoDate(year: number, month: number, day: number): string {
	const date = new Date(Date.UTC(year, month, day));
	return date.toISOString().slice(0, 10);
}

export function shiftMonth(month: CalendarMonth, by: number): CalendarMonth {
	const index = month.year * 12 + month.month + by;
	return { year: Math.floor(index / 12), month: ((index % 12) + 12) % 12 };
}

export function monthOf(date: Date): CalendarMonth {
	return { year: date.getFullYear(), month: date.getMonth() };
}

export function formatMonthLabel(month: CalendarMonth): string {
	return new Date(month.year, month.month, 1).toLocaleDateString(undefined, {
		month: "long",
		year: "numeric",
	});
}

function gridDates(month: CalendarMonth): string[][] {
	const first = new Date(Date.UTC(month.year, month.month, 1));
	// Monday-first: Sunday (0) is the 7th column.
	const leading = (first.getUTCDay() + 6) % 7;
	const daysInMonth = new Date(
		Date.UTC(month.year, month.month + 1, 0),
	).getUTCDate();
	const weekCount = Math.ceil((leading + daysInMonth) / 7);
	const weeks: string[][] = [];
	for (let week = 0; week < weekCount; week += 1) {
		const days: string[] = [];
		for (let weekday = 0; weekday < 7; weekday += 1) {
			days.push(
				isoDate(month.year, month.month, 1 - leading + week * 7 + weekday),
			);
		}
		weeks.push(days);
	}
	return weeks;
}

/** Bucket the rows (already in view sort order) into the month's grid. */
export function buildCalendarModel(
	rows: readonly DocumentTableRow[],
	field: PropertyField,
	month: CalendarMonth,
	dayLimit: number = CALENDAR_DAY_CARD_LIMIT,
): CalendarModel {
	const dates = gridDates(month);
	const byDate = new Map<string, DocumentTableRow[]>();
	for (const week of dates) for (const date of week) byDate.set(date, []);
	let outsideCount = 0;
	let undatedCount = 0;
	for (const row of rows) {
		const value = row.properties?.[field.id];
		if (typeof value !== "string") {
			undatedCount += 1;
			continue;
		}
		const day = calendarDayOf(value);
		const bucket = day ? byDate.get(day) : undefined;
		if (bucket) bucket.push(row);
		else outsideCount += 1;
	}
	const monthPrefix = isoDate(month.year, month.month, 1).slice(0, 7);
	const weeks = dates.map((week) =>
		week.map((date) => {
			const bucket = byDate.get(date) ?? [];
			return {
				date,
				dayOfMonth: Number(date.slice(8, 10)),
				inMonth: date.startsWith(monthPrefix),
				rows: bucket.slice(0, dayLimit),
				allRows: bucket,
				total: bucket.length,
			};
		}),
	);
	return { field, month, weeks, outsideCount, undatedCount };
}

/** `YYYY-MM-DD` moved by whole days (UTC, so no DST surprises). */
export function shiftDate(date: string, days: number): string {
	const [year, month, day] = date.split("-").map(Number);
	return isoDate(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days);
}

export type CalendarMoveTarget = { label: string; date: string | null };

/** Keyboard "Move to" choices for a note dated `date`. */
export function calendarMoveTargets(date: string): CalendarMoveTarget[] {
	return [
		{ label: "Previous day", date: shiftDate(date, -1) },
		{ label: "Next day", date: shiftDate(date, 1) },
		{ label: "Same day next week", date: shiftDate(date, 7) },
		{ label: "Same day last week", date: shiftDate(date, -7) },
		{ label: "Remove date", date: null },
	];
}
