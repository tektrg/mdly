/**
 * Shared date wording for list rows (desktop card rows + kit recent files):
 * one compact date beside the title, and a hover tooltip naming both facts
 * with full datetimes. Day-first English ("3 Nov") regardless of locale.
 */

/** "10:50 PM" today, "3 Nov" this year, "3 Nov 2025" otherwise. Input in ms. */
export function formatRowDate(ms: number, now = new Date()): string {
	const at = new Date(ms);
	if (Number.isNaN(at.getTime())) return "";
	if (at.toDateString() === now.toDateString())
		return at.toLocaleTimeString("en-US", {
			hour: "numeric",
			minute: "2-digit",
		});
	const dayMonth = `${at.getDate()} ${at.toLocaleString("en-GB", { month: "short" })}`;
	return at.getFullYear() === now.getFullYear()
		? dayMonth
		: `${dayMonth} ${at.getFullYear()}`;
}

/** "3 Nov 2026, 10:50 PM". Input in ms. */
export function formatFullDateTime(ms: number): string {
	const at = new Date(ms);
	if (Number.isNaN(at.getTime())) return "";
	const time = at.toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "2-digit",
	});
	return `${at.getDate()} ${at.toLocaleString("en-GB", { month: "short" })} ${at.getFullYear()}, ${time}`;
}

export type RowDateField = "modified" | "created";

export type RowDate = { field: RowDateField; label: string; title: string };

/**
 * The single date a row shows: the list's sort field when it is a date,
 * modified otherwise. Tooltip lists Modified then Created, padded to align.
 */
export function rowDate(
	modifiedMs: number,
	createdMs: number | undefined,
	sortField: string | undefined,
	now = new Date(),
): RowDate {
	const field: RowDateField =
		sortField === "created" && createdMs != null ? "created" : "modified";
	const label = formatRowDate(
		field === "created" ? (createdMs as number) : modifiedMs,
		now,
	);
	const lines = [`Modified  ${formatFullDateTime(modifiedMs)}`];
	if (createdMs != null)
		lines.push(`Created   ${formatFullDateTime(createdMs)}`);
	return { field, label, title: lines.join("\n") };
}
