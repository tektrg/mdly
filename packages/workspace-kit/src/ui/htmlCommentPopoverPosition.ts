export interface Rect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/**
 * Where to put a note popover (viewport coords) so it stays inside `bounds`.
 * Default: below the marker, left-aligned to it. Flips to above when it
 * would overflow the bottom and fits better above; flips to end-aligned
 * (expanding leftwards) when it would overflow the right. Finally clamps.
 */
export function placeNotePopover(
	anchor: Rect,
	size: { width: number; height: number },
	bounds: Rect,
	gap = 6,
	pad = 8,
): { left: number; top: number; placement: "below" | "above" } {
	const minLeft = bounds.left + pad;
	const maxRight = bounds.right - pad;
	let left = anchor.left - 8;
	if (left + size.width > maxRight) left = anchor.right + 8 - size.width;
	left = Math.max(minLeft, Math.min(left, maxRight - size.width));

	const below = anchor.bottom + gap;
	const above = anchor.top - gap - size.height;
	const fitsBelow = below + size.height <= bounds.bottom - pad;
	const fitsAbove = above >= bounds.top + pad;
	const useAbove =
		!fitsBelow &&
		(fitsAbove || anchor.top - bounds.top > bounds.bottom - anchor.bottom);
	let top = useAbove ? above : below;
	top = Math.max(
		bounds.top + pad,
		Math.min(top, bounds.bottom - pad - size.height),
	);
	return { left, top, placement: useAbove ? "above" : "below" };
}
