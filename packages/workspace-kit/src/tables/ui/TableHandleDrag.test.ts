// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { TableHandleDrag } from "./TableHandleDrag.js";

function startDrag(
	overrides: Partial<Parameters<typeof TableHandleDrag.begin>[0]> = {},
) {
	const onIndicator = vi.fn();
	const onEnd = vi.fn();
	const drag = TableHandleDrag.begin({
		kind: "column",
		fromIndex: 0,
		itemCount: 3,
		slotEdges: [0, 100, 200, 300],
		originClient: 500,
		startClient: 550,
		callbacks: { onIndicator, onEnd },
		...overrides,
	});
	return { drag, onIndicator, onEnd };
}

describe("TableHandleDrag", () => {
	it("O2: a real move reports the slot, then commits the adjusted index", () => {
		const { drag, onIndicator, onEnd } = startDrag();
		// Pointer at client 750 → offset 250 → slot 2 → toIndex 1.
		drag.handleMove(750);
		expect(onIndicator).toHaveBeenLastCalledWith(2);
		drag.handleUp(750);
		expect(onEnd).toHaveBeenCalledTimes(1);
		expect(onEnd).toHaveBeenCalledWith({ kind: "commit", toIndex: 1 });
	});

	it("O6: a drop back at the origin hides the indicator and cancels", () => {
		const { drag, onIndicator, onEnd } = startDrag();
		drag.handleMove(560);
		expect(onIndicator).toHaveBeenLastCalledWith(null);
		drag.handleUp(560);
		expect(onEnd).toHaveBeenCalledWith({ kind: "cancel" });
	});

	it("R4: a press without movement ends as a click (opens the menu)", () => {
		const { drag, onEnd } = startDrag();
		drag.handleMove(551);
		drag.handleUp(552);
		expect(onEnd).toHaveBeenCalledWith({ kind: "click" });
	});

	it("R13: cancel ends once, and later moves do nothing", () => {
		const { drag, onIndicator, onEnd } = startDrag();
		drag.handleMove(750);
		drag.cancel();
		expect(onEnd).toHaveBeenCalledWith({ kind: "cancel" });
		drag.handleMove(750);
		drag.handleUp(750);
		expect(onEnd).toHaveBeenCalledTimes(1);
		expect(onIndicator).toHaveBeenLastCalledWith(null);
	});

	it("O3: rows drag on the same math with body-relative indices", () => {
		const onIndicator = vi.fn();
		const onEnd = vi.fn();
		const drag = TableHandleDrag.begin({
			kind: "row",
			fromIndex: 2,
			itemCount: 3,
			slotEdges: [0, 40, 80, 120],
			originClient: 200,
			startClient: 300,
			callbacks: { onIndicator, onEnd },
		});
		drag.handleMove(205);
		drag.handleUp(205);
		expect(onEnd).toHaveBeenCalledWith({ kind: "commit", toIndex: 0 });
	});
});
