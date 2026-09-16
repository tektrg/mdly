import { NAV_RAIL_MIN_WIDTH, PEEK_DOCUMENT_MIN_WIDTH } from "../lib/navLayout";

/**
 * R9's four density tiers, and R13's divider clamp, as pure arithmetic.
 *
 * Nothing here reads the DOM or `window`: density is driven by the CONTAINER
 * width the caller measured, so the same number always yields the same tier no
 * matter how wide the window around it is (EC-20). It also keeps every claim in
 * this file provable under happy-dom, which has no layout at all.
 */

export type NavDensityTier = "rail" | "list" | "card" | "table";

/**
 * The fields a row can show, in the order they earn their place as the list
 * widens. R9 forbids per-tier field configuration, so a tier never *picks*
 * fields — it only takes a PREFIX of this one array.
 */
export const COLUMN_PRIORITY = ["name", "modified", "folder", "tags"] as const;

export type NavColumn = (typeof COLUMN_PRIORITY)[number];

/**
 * The density ladder, narrowest first: one ordered table, read for both the
 * threshold and the prefix length. A tier is "the widest rung whose `minWidth`
 * the container has reached", which is why the thresholds need no upper bounds
 * and cannot develop a gap.
 */
const DENSITY_LADDER = [
	{ tier: "rail", minWidth: 0, columnCount: 1 },
	{ tier: "list", minWidth: 260, columnCount: 2 },
	{ tier: "card", minWidth: 400, columnCount: 4 },
	{ tier: "table", minWidth: 560, columnCount: 4 },
] as const satisfies readonly {
	tier: NavDensityTier;
	minWidth: number;
	columnCount: number;
}[];

type DensityRung = (typeof DENSITY_LADDER)[number];

function rungFor(containerWidth: number): DensityRung {
	let rung: DensityRung = DENSITY_LADDER[0];
	for (const candidate of DENSITY_LADDER) {
		if (containerWidth >= candidate.minWidth) rung = candidate;
	}
	return rung;
}

/** R9: the tier for a measured CONTAINER width — never a window width. */
export function densityTier(containerWidth: number): NavDensityTier {
	return rungFor(containerWidth).tier;
}

/**
 * The columns a tier shows: a prefix of {@link COLUMN_PRIORITY}. Card and Table
 * deliberately show the SAME fields — the ladder's last step changes the layout
 * (stacked card → one line with column headers), not the field set.
 */
export function columnsForTier(tier: NavDensityTier): NavColumn[] {
	const rung = DENSITY_LADDER.find((candidate) => candidate.tier === tier);
	return COLUMN_PRIORITY.slice(0, rung?.columnCount ?? 1);
}

/** A10: indentation grows per level up to this depth, then stops. */
export const NAV_INDENT_MAX_LEVELS = 4;

const NAV_INDENT_BASE_REM = 0.5;
const NAV_INDENT_STEP_REM = 0.75;

/**
 * A10's indent ceiling. Takes `depth` and NOTHING else: the ceiling is one
 * constant in this module, not per-tier configuration, so a seven-deep document
 * is inset identically at Rail and at Table and the disclosure arrows carry the
 * hierarchy past level 4.
 */
export function navIndentRem(depth: number): number {
	const level = Math.min(Math.max(depth, 0), NAV_INDENT_MAX_LEVELS);
	return NAV_INDENT_BASE_REM + level * NAV_INDENT_STEP_REM;
}

/**
 * How a clamped peek split was reached. The degenerate case is NAMED rather
 * than returned as a silently-laid-out number: below `documentMinWidth +
 * NAV_RAIL_MIN_WIDTH` of split width there is no honest answer, so the list
 * takes the rail minimum and the document takes whatever remains — never zero,
 * never negative.
 */
export type PeekWidthOutcome = "desired" | "clamped" | "degenerate";

export type PeekSplitWidths = {
	listWidth: number;
	documentWidth: number;
	outcome: PeekWidthOutcome;
};

/**
 * R13's floor, applied at RENDER time to the user's persisted DESIRED width.
 *
 * The desired width is never overwritten by this function — that is the whole
 * mechanism behind EC-30: shrinking clamps the render, widening lets the same
 * stored desire through again untouched.
 *
 * A11 makes the degenerate branch unreachable by dragging the window, but the
 * split container can still be narrower than `WINDOW_MIN_WIDTH` mid-transition,
 * so it stays reachable in code and is reported rather than hidden.
 */
export function clampPeekListWidth({
	availableWidth,
	desiredWidth,
	documentMinWidth = PEEK_DOCUMENT_MIN_WIDTH,
}: {
	availableWidth: number;
	desiredWidth: number;
	documentMinWidth?: number;
}): PeekSplitWidths {
	const maxListWidth = availableWidth - documentMinWidth;
	if (maxListWidth < NAV_RAIL_MIN_WIDTH) {
		return {
			listWidth: NAV_RAIL_MIN_WIDTH,
			documentWidth: Math.max(0, availableWidth - NAV_RAIL_MIN_WIDTH),
			outcome: "degenerate",
		};
	}
	const listWidth = Math.min(
		Math.max(desiredWidth, NAV_RAIL_MIN_WIDTH),
		maxListWidth,
	);
	return {
		listWidth,
		documentWidth: availableWidth - listWidth,
		outcome: listWidth === desiredWidth ? "desired" : "clamped",
	};
}
