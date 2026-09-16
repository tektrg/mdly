/**
 * The three widths peek navigation is built out of, in one place.
 *
 * Deliberately DOM-free and dependency-free: `electron/main.ts` imports it to
 * size the `BrowserWindow`, and the renderer imports it to clamp the divider.
 * A second copy of 780 in the main process is exactly the drift A11 exists to
 * prevent, so the window floor is DERIVED here and never written twice.
 */

/** R13: the width below which an open document stops being readable. */
export const PEEK_DOCUMENT_MIN_WIDTH = 600;

/** The narrowest the navigation list is ever laid out at — the Rail tier. */
export const NAV_RAIL_MIN_WIDTH = 180;

/**
 * A11: the window minimum, so R13's document floor is true by construction
 * rather than by clamping after the window has already been dragged too narrow.
 */
export const WINDOW_MIN_WIDTH = PEEK_DOCUMENT_MIN_WIDTH + NAV_RAIL_MIN_WIDTH;

/**
 * A11 / EC-98: raise a window width saved before the floor existed, without
 * discarding the rest of the saved state.
 *
 * A width below the floor is a legal record from an earlier version, not
 * corruption. Rejecting it would lose the position and height saved alongside
 * it, so the width alone is raised and everything else is kept.
 */
export function windowWidthWithFloor(width: number): number {
	return Math.max(width, WINDOW_MIN_WIDTH);
}
