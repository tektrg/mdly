import { describe, expect, it } from "vitest";
import {
	initialSwipeNavState,
	resolveSwipeStep,
	SWIPE_COOLDOWN_MS,
	SWIPE_TRIGGER_PX,
	type SwipeNavState,
} from "./useSidebarSwipeNav";

describe("resolveSwipeStep", () => {
	it("flips on a single horizontal-dominant event past the trigger threshold", () => {
		const result = resolveSwipeStep(initialSwipeNavState, {
			deltaX: SWIPE_TRIGGER_PX + 10,
			deltaY: 0,
			now: 1000,
		});

		expect(result.pageDelta).toBe(1);
		expect(result.shouldPreventDefault).toBe(true);
	});

	it("never flips on a vertical-dominant event regardless of magnitude", () => {
		const result = resolveSwipeStep(initialSwipeNavState, {
			deltaX: SWIPE_TRIGGER_PX + 500,
			deltaY: SWIPE_TRIGGER_PX + 500,
			now: 1000,
		});

		expect(result.pageDelta).toBe(0);
	});

	it("does not flip below the cumulative threshold, but accumulates and eventually flips", () => {
		let state: SwipeNavState = initialSwipeNavState;
		let now = 1000;

		const first = resolveSwipeStep(state, { deltaX: 20, deltaY: 0, now });
		expect(first.pageDelta).toBe(0);
		state = first.nextState;
		now += 10;

		const second = resolveSwipeStep(state, { deltaX: 20, deltaY: 0, now });
		expect(second.pageDelta).toBe(0);
		state = second.nextState;
		now += 10;

		const third = resolveSwipeStep(state, { deltaX: 30, deltaY: 0, now });
		expect(third.pageDelta).toBe(1);
	});

	it("suppresses further flips during the cooldown window after a flip", () => {
		const flipped = resolveSwipeStep(initialSwipeNavState, {
			deltaX: SWIPE_TRIGGER_PX + 10,
			deltaY: 0,
			now: 1000,
		});
		expect(flipped.pageDelta).toBe(1);

		const duringCooldown = resolveSwipeStep(flipped.nextState, {
			deltaX: SWIPE_TRIGGER_PX + 10,
			deltaY: 0,
			now: 1000 + SWIPE_COOLDOWN_MS - 1,
		});
		expect(duringCooldown.pageDelta).toBe(0);

		const afterCooldown = resolveSwipeStep(flipped.nextState, {
			deltaX: SWIPE_TRIGGER_PX + 10,
			deltaY: 0,
			now: 1000 + SWIPE_COOLDOWN_MS + 1,
		});
		expect(afterCooldown.pageDelta).toBe(1);
	});

	it("resets accumulation on direction reversal instead of netting the two out", () => {
		let state: SwipeNavState = initialSwipeNavState;
		let now = 1000;

		const forward = resolveSwipeStep(state, { deltaX: 40, deltaY: 0, now });
		expect(forward.pageDelta).toBe(0);
		state = forward.nextState;
		now += 10;

		// A small reversal should NOT leave a net +... accumulation from the
		// forward swipe; it restarts the count from this event's delta alone.
		const reversed = resolveSwipeStep(state, { deltaX: -10, deltaY: 0, now });
		expect(reversed.pageDelta).toBe(0);
		expect(reversed.nextState.accumulatedDeltaX).toBe(-10);
	});

	it("resets accumulation after an idle gap between events", () => {
		let state: SwipeNavState = initialSwipeNavState;
		const first = resolveSwipeStep(state, { deltaX: 40, deltaY: 0, now: 1000 });
		state = first.nextState;

		const afterGap = resolveSwipeStep(state, {
			deltaX: 30,
			deltaY: 0,
			now: 1000 + 1000, // far past SWIPE_IDLE_RESET_MS
		});

		// Would have summed to 70 (past threshold) if not reset; instead only
		// this event's own 30px counts, which stays under the trigger.
		expect(afterGap.pageDelta).toBe(0);
		expect(afterGap.nextState.accumulatedDeltaX).toBe(30);
	});
});
