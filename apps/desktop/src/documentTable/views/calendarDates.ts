/**
 * Calendar day of a date property value, by table-core's `dateBucketOf` rule:
 * a value ending in `Z` / `±HH:MM` is an instant, shown on its LOCAL day;
 * anything else is wall-clock and its first 10 characters are the day.
 */
const HAS_OFFSET = /(?:[Zz]|[+-]\d{2}:\d{2})$/;

function isInstant(value: string): boolean {
	return value.length > 10 && HAS_OFFSET.test(value);
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

function localParts(ms: number) {
	const at = new Date(ms);
	return {
		day: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
		time: `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`,
	};
}

/** `YYYY-MM-DD` the calendar files this value under; null when it is not a date. */
export function calendarDayOf(value: string): string | null {
	if (isInstant(value)) {
		const ms = Date.parse(value);
		return Number.isNaN(ms) ? null : localParts(ms).day;
	}
	return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function offsetSuffix(ms: number): string {
	const minutes = -new Date(ms).getTimezoneOffset();
	const sign = minutes >= 0 ? "+" : "-";
	const abs = Math.abs(minutes);
	return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * The value moved to `day`, keeping its time: a date stays a date, a
 * wall-clock date-time keeps its time text, an instant keeps its local time
 * and is written with the local offset of the new moment.
 */
export function moveValueToDay(value: string, day: string): string {
	if (isInstant(value)) {
		const ms = Date.parse(value);
		if (Number.isNaN(ms)) return day;
		const moved = new Date(`${day}T${localParts(ms).time}`).getTime();
		return `${day}T${localParts(moved).time}${offsetSuffix(moved)}`;
	}
	return value.length > 10 ? `${day}${value.slice(10)}` : day;
}
