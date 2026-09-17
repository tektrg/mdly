/**
 * Pure drop-slot math for slice 1 handle drags (charter R38).
 *
 * Everything here is DOM-free numbers in, numbers out, so it is unit-tested
 * without a browser. The drag session (`TableHandleDrag.ts`) captures the
 * pixel boundaries once at drag start and then calls into these helpers per
 * pointer move — the move path itself never reads layout.
 */

/** A no-movement gesture must commit nothing (R8). */
export const HANDLE_DRAG_CLICK_THRESHOLD_PX = 4;

/**
 * Which slot the pointer is over. `slotEdges` has one entry per slot
 * boundary: for N items it holds N+1 ascending pixel offsets (0 first, the
 * far edge last), all measured in the same space as `offset`. Returns the
 * slot index in [0, N] — "insert before item i", N meaning "after the last".
 */
export function dropSlotIndex(slotEdges: number[], offset: number): number {
	const slotCount = Math.max(0, slotEdges.length - 1);
	let slot = 0;
	while (slot < slotCount) {
		const edge = slotEdges[slot + 1] ?? Number.POSITIVE_INFINITY;
		if (offset < edge) break;
		slot += 1;
	}
	return slot;
}

/**
 * Translate a drop slot into the `to` argument of `moveTableColumn` /
 * `moveTableRow`. Those helpers splice the dragged item out first and then
 * insert, so a slot past the origin shifts down by one. Returns `fromIndex`
 * unchanged when the drop lands back where the drag started — the caller
 * treats that as a cancelled drag and dispatches nothing (R8).
 */
export function moveTargetIndex(
	fromIndex: number,
	dropSlot: number,
	itemCount: number,
): number {
	const clampedSlot = Math.max(0, Math.min(dropSlot, itemCount));
	const toIndex = clampedSlot > fromIndex ? clampedSlot - 1 : clampedSlot;
	return Math.max(0, Math.min(toIndex, itemCount - 1));
}

/**
 * Build the slot edges for N items laid out back to back from 0 to
 * `totalExtent`, splitting the difference at each internal divider so every
 * pixel belongs to exactly one slot. Used when real cell edges are
 * unavailable (e.g. a ragged row measured only by the table's own box).
 */
export function evenSlotEdges(
	itemCount: number,
	totalExtent: number,
): number[] {
	if (itemCount <= 0 || totalExtent <= 0) return [0];
	const edges: number[] = [];
	for (let i = 0; i <= itemCount; i++) {
		edges.push((totalExtent * i) / itemCount);
	}
	return edges;
}
