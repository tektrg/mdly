import {
	dropSlotIndex,
	HANDLE_DRAG_CLICK_THRESHOLD_PX,
	moveTargetIndex,
} from "./tableGeometry.js";

/**
 * Pointer-drag session for one column/row dot (charter R38).
 *
 * All pixel boundaries are captured once in `begin` — the move path below
 * reads no layout at all, it only subtracts the captured origin from the
 * pointer's client coordinates. The layer owns every DOM read (cell edges,
 * the wrapper's client origin) and every DOM write (the drop indicator);
 * this class is pure pointer-math plus a single end callback, so it is
 * unit-tested without a browser.
 */

export type TableHandleDragKind = "column" | "row";

export type TableHandleDragEnd =
	/** The pointer barely moved: treat the press as a click (opens the menu). */
	| { kind: "click" }
	/** Commit the reorder to this body-relative/column index. */
	| { kind: "commit"; toIndex: number }
	/** Escape, pointer cancel, blur, drop outside, or drop back at origin. */
	| { kind: "cancel" };

export type TableHandleDragCallbacks = {
	/** Drop slot the indicator should sit at, or null to hide it. */
	onIndicator: (slot: number | null) => void;
	onEnd: (end: TableHandleDragEnd) => void;
};

export type TableHandleDragBegin = {
	kind: TableHandleDragKind;
	fromIndex: number;
	itemCount: number;
	/** Ascending slot edges in content pixels, captured once at drag start. */
	slotEdges: number[];
	/** Client origin the offsets are measured from, captured at drag start. */
	originClient: number;
	startClient: number;
	callbacks: TableHandleDragCallbacks;
};

export class TableHandleDrag {
	private ended = false;
	private readonly kind: TableHandleDragKind;
	private readonly fromIndex: number;
	private readonly itemCount: number;
	private readonly slotEdges: number[];
	private readonly originClient: number;
	private readonly startClient: number;
	private readonly callbacks: TableHandleDragCallbacks;

	private constructor(begin: TableHandleDragBegin) {
		this.kind = begin.kind;
		this.fromIndex = begin.fromIndex;
		this.itemCount = begin.itemCount;
		this.slotEdges = begin.slotEdges;
		this.originClient = begin.originClient;
		this.startClient = begin.startClient;
		this.callbacks = begin.callbacks;
	}

	static begin(begin: TableHandleDragBegin): TableHandleDrag {
		return new TableHandleDrag(begin);
	}

	get dragKind(): TableHandleDragKind {
		return this.kind;
	}

	/** Pointer move: pure arithmetic, no layout reads (R38). */
	handleMove(client: number): void {
		if (this.ended) return;
		if (Math.abs(client - this.startClient) < HANDLE_DRAG_CLICK_THRESHOLD_PX) {
			this.callbacks.onIndicator(null);
			return;
		}
		const slot = dropSlotIndex(this.slotEdges, client - this.originClient);
		const toIndex = moveTargetIndex(this.fromIndex, slot, this.itemCount);
		this.callbacks.onIndicator(toIndex === this.fromIndex ? null : slot);
	}

	/** Pointer release: click, commit, or cancel — exactly one `onEnd`. */
	handleUp(client: number): void {
		if (this.ended) return;
		if (Math.abs(client - this.startClient) < HANDLE_DRAG_CLICK_THRESHOLD_PX) {
			this.finish({ kind: "click" });
			return;
		}
		const slot = dropSlotIndex(this.slotEdges, client - this.originClient);
		const toIndex = moveTargetIndex(this.fromIndex, slot, this.itemCount);
		this.finish(
			toIndex === this.fromIndex
				? { kind: "cancel" }
				: { kind: "commit", toIndex },
		);
	}

	cancel(): void {
		this.finish({ kind: "cancel" });
	}

	private finish(end: TableHandleDragEnd): void {
		if (this.ended) return;
		this.ended = true;
		this.callbacks.onIndicator(null);
		this.callbacks.onEnd(end);
	}
}
