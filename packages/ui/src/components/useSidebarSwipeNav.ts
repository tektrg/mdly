import type { WheelEvent as ReactWheelEvent } from "react";
import { useCallback, useRef } from "react";

/** Cumulative horizontal distance (px) required before a swipe flips a page. */
export const SWIPE_TRIGGER_PX = 60;
/** |deltaX| must exceed |deltaY| by this ratio to count as a horizontal swipe. */
export const SWIPE_RATIO = 1.5;
/** After a flip, further flips are ignored for this long so one physical swipe
 * gesture (which fires many wheel events) only flips one page. */
export const SWIPE_COOLDOWN_MS = 400;
/** A gap this long between wheel events resets the in-progress accumulation. */
export const SWIPE_IDLE_RESET_MS = 150;

export type SwipeNavState = {
	accumulatedDeltaX: number;
	lastEventAt: number;
	cooldownUntil: number;
};

export const initialSwipeNavState: SwipeNavState = {
	accumulatedDeltaX: 0,
	lastEventAt: 0,
	cooldownUntil: 0,
};

export type SwipeNavResult = {
	nextState: SwipeNavState;
	/** -1/1 when this event crosses the trigger threshold; 0 otherwise. */
	pageDelta: -1 | 0 | 1;
	shouldPreventDefault: boolean;
};

function isHorizontalDominant(deltaX: number, deltaY: number) {
	return Math.abs(deltaX) > Math.abs(deltaY) * SWIPE_RATIO;
}

/** Pure decision function: given the running swipe state and one wheel event,
 * decide whether a page flip should fire. Kept DOM-free so it's unit-testable
 * without constructing real WheelEvents (mirrors the split in
 * `scrollEditorViewportFromFindBarWheel` in editor/FindReplaceBar.tsx). */
export function resolveSwipeStep(
	state: SwipeNavState,
	event: { deltaX: number; deltaY: number; now: number },
): SwipeNavResult {
	const { deltaX, deltaY, now } = event;

	if (now < state.cooldownUntil) {
		return {
			nextState: state,
			pageDelta: 0,
			shouldPreventDefault: isHorizontalDominant(deltaX, deltaY),
		};
	}

	if (!isHorizontalDominant(deltaX, deltaY)) {
		if (state.accumulatedDeltaX === 0) {
			return { nextState: state, pageDelta: 0, shouldPreventDefault: false };
		}
		// Diagonal/vertical motion breaks a run of horizontal motion.
		return {
			nextState: { ...state, accumulatedDeltaX: 0, lastEventAt: now },
			pageDelta: 0,
			shouldPreventDefault: false,
		};
	}

	const isIdleGap =
		state.accumulatedDeltaX !== 0 &&
		now - state.lastEventAt > SWIPE_IDLE_RESET_MS;
	const isReversal =
		state.accumulatedDeltaX !== 0 &&
		Math.sign(deltaX) !== Math.sign(state.accumulatedDeltaX);
	const startingDeltaX = isIdleGap || isReversal ? 0 : state.accumulatedDeltaX;
	const accumulatedDeltaX = startingDeltaX + deltaX;

	if (Math.abs(accumulatedDeltaX) < SWIPE_TRIGGER_PX) {
		return {
			nextState: {
				accumulatedDeltaX,
				lastEventAt: now,
				cooldownUntil: state.cooldownUntil,
			},
			pageDelta: 0,
			shouldPreventDefault: true,
		};
	}

	// Positive accumulated deltaX (scrolling right) advances to the next page,
	// matching a leftward two-finger swipe under natural scrolling.
	const pageDelta = accumulatedDeltaX > 0 ? 1 : -1;
	return {
		nextState: {
			accumulatedDeltaX: 0,
			lastEventAt: now,
			cooldownUntil: now + SWIPE_COOLDOWN_MS,
		},
		pageDelta,
		shouldPreventDefault: true,
	};
}

/** Wires wheel events on a container into page-flip calls, clamped to
 * `[0, pageCount - 1]` with no wrap-around at either end. */
export function useSidebarSwipeNav({
	activePage,
	pageCount,
	onPageChange,
}: {
	activePage: number;
	pageCount: number;
	onPageChange: (page: number) => void;
}) {
	const stateRef = useRef<SwipeNavState>(initialSwipeNavState);
	const activePageRef = useRef(activePage);
	activePageRef.current = activePage;

	const onWheel = useCallback(
		(event: ReactWheelEvent<HTMLElement>) => {
			const result = resolveSwipeStep(stateRef.current, {
				deltaX: event.deltaX,
				deltaY: event.deltaY,
				now: Date.now(),
			});
			stateRef.current = result.nextState;
			if (result.shouldPreventDefault) event.preventDefault();
			if (result.pageDelta === 0) return;
			const nextPage = activePageRef.current + result.pageDelta;
			if (nextPage < 0 || nextPage >= pageCount) return;
			onPageChange(nextPage);
		},
		[onPageChange, pageCount],
	);

	return { onWheel };
}
