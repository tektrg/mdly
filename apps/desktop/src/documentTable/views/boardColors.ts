import type { BoardColumnColor } from "../properties/documentViews";

/**
 * Board label hues are a user choice (like Notion's), not theme surfaces,
 * so they use Tailwind's palette at low alpha with a dark-mode text shade.
 * Literal class strings per colour: Tailwind only emits classes it can see
 * in the source text, so these are never composed at runtime.
 */
export const BOARD_COLOR_CLASSES: Record<
	BoardColumnColor,
	{ dot: string; pill: string; label: string }
> = {
	gray: {
		dot: "bg-zinc-400",
		pill: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
		label: "Grey",
	},
	brown: {
		dot: "bg-amber-800",
		pill: "bg-amber-800/15 text-amber-900 dark:text-amber-200",
		label: "Brown",
	},
	orange: {
		dot: "bg-orange-500",
		pill: "bg-orange-500/15 text-orange-800 dark:text-orange-300",
		label: "Orange",
	},
	yellow: {
		dot: "bg-yellow-400",
		pill: "bg-yellow-400/20 text-yellow-800 dark:text-yellow-200",
		label: "Yellow",
	},
	green: {
		dot: "bg-green-500",
		pill: "bg-green-500/15 text-green-800 dark:text-green-300",
		label: "Green",
	},
	blue: {
		dot: "bg-blue-500",
		pill: "bg-blue-500/15 text-blue-800 dark:text-blue-300",
		label: "Blue",
	},
	purple: {
		dot: "bg-purple-500",
		pill: "bg-purple-500/15 text-purple-800 dark:text-purple-300",
		label: "Purple",
	},
	pink: {
		dot: "bg-pink-500",
		pill: "bg-pink-500/15 text-pink-800 dark:text-pink-300",
		label: "Pink",
	},
	red: {
		dot: "bg-red-500",
		pill: "bg-red-500/15 text-red-800 dark:text-red-300",
		label: "Red",
	},
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Today", "Tomorrow", "Yesterday", "in 3 days", "5 days ago", else the date. */
export function relativeDateLabel(
	value: string,
	now: Date = new Date(),
): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
	if (!match) return value;
	const day = new Date(
		Number(match[1]),
		Number(match[2]) - 1,
		Number(match[3]),
	);
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const diff = Math.round((day.getTime() - today.getTime()) / DAY_MS);
	if (diff === 0) return "Today";
	if (diff === 1) return "Tomorrow";
	if (diff === -1) return "Yesterday";
	if (diff > 1 && diff < 7) return `in ${diff} days`;
	if (diff < -1 && diff > -7) return `${-diff} days ago`;
	return day.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		...(day.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
	});
}
