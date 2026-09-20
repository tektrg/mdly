import type { Editor } from "@tiptap/react";
import {
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
// @ts-expect-error The kit does not ship react-dom types (same precedent as
// EditorView.test.tsx's react-dom/client import); react-dom itself is a real
// dependency so this resolves at runtime and in the bundler.
import { createPortal } from "react-dom";
import { TABLE_OVERLAY_MOUNT_ATTR } from "../../engine/Table.js";
import { tableTransformTransaction } from "../applyTableTransform.js";
import {
	deleteTableColumn,
	deleteTableRow,
	moveTableColumn,
	moveTableRow,
} from "../tableTransforms.js";
import { TableHandleDrag } from "./TableHandleDrag.js";
import styles from "./TableInteractionLayer.module.css";
import { TableWidthControl } from "./TableWidthControl";
import { evenSlotEdges } from "./tableGeometry.js";
import type {
	TableInteractionLayerProps,
	TableTarget,
} from "./tableInteractionTypes.js";
import { type TableHandleTarget, useTableTargets } from "./useTableTargets.js";

type DotMenuState = {
	uid: string;
	kind: "column" | "row";
	index: number;
	/** Content-relative anchor so the menu tracks the table by CSS (R36). */
	anchorInline: number;
	anchorTop: number;
};

type ActiveDrag = {
	session: TableHandleDrag;
	uid: string;
	kind: "column" | "row";
	fromIndex: number;
	itemCount: number;
	indicator: HTMLElement | null;
	slotEdges: number[];
	detachListeners: () => void;
};

/**
 * Block-start margin the table's wrapper had before the chrome frame was
 * installed, handed to the stylesheet as a custom property so the frame's own
 * negative margin can be added to it (see `.chrome` in the module CSS). The
 * editor sets that margin per neighbour, so it cannot be written into a
 * stylesheet once.
 */
const FLOW_MARGIN_VAR = "--table-flow-margin-block-start";

/**
 * Marks the wrapper the chrome frame is installed on. The editor's own
 * stylesheet (`EditorView.css`) lifts its `max-inline-size: 100%` cap from
 * wrappers carrying this attribute, so the band and gutter above and the
 * full-width rule can outgrow the prose column. Must stay in step with the
 * `:not([data-table-chrome])` selector there.
 */
const TABLE_CHROME_ATTR = "data-table-chrome";

/** Dots in a grip: a 2×3 grid, per the reference design. */
const GRIP_DOT_COUNT = 6;

/**
 * How long the chrome stays up after the pointer leaves the table. The handles
 * and the expand chip sit *outside* the table's own box, so reaching for one
 * crosses the wrapper's edge; without this grace period the chrome vanishes
 * from under the pointer that is on its way to click it.
 */
const HOVER_HIDE_DELAY_MS = 1000;

/** The cell under the pointer, as indices only — never geometry (R35). */
type HoveredCell = {
	column: number;
	/** Body-row index, or null while the pointer is over the header (R3). */
	row: number | null;
};

/** The two handles the overlay draws, or null where the pointer is not. */
type HandleSlot = {
	column: number | null;
	row: number | null;
};

const NO_SLOT: HandleSlot = { column: null, row: null };

/**
 * Slice 1 — hover handles, drag-to-reorder, handle menu Delete.
 *
 * The layer discovers every GFM table (docChanged-gated, rAF-coalesced — see
 * `useTableTargets`) and portals one overlay into the NodeView-owned mount
 * inside each table's own `.tableWrapper` scroll box (charter R36), so handles
 * track scrolling, resize and panel toggles by CSS with no scroll/resize
 * listeners. Each overlay draws exactly two handles, and only for the cell the
 * pointer is in: the column pill above that column's top edge and the row grip
 * in that body row's left gutter. Handles are drawn, never inserted: hovering
 * reads layout only while the pointer is over a table (R35), a drag reads no
 * layout per move (R38), and anything short of a real drop or Delete
 * dispatches nothing at all (R8).
 */
export function TableInteractionLayer({
	editor,
	viewportRef,
	editable,
}: TableInteractionLayerProps) {
	const { targets, rescanEpoch } = useTableTargets(editor);
	const [hoveredUid, setHoveredUid] = useState<string | null>(null);
	const [menu, setMenu] = useState<DotMenuState | null>(null);
	const dragRef = useRef<ActiveDrag | null>(null);
	const hoveredUidRef = useRef<string | null>(null);
	hoveredUidRef.current = hoveredUid;

	// R42 — an external rewrite swaps the document underneath us: abort an
	// in-flight drag, drop a menu pointing at stale indices, and clear hover
	// when its table leaves the page. Our own commits land after the drag
	// already ended (dragRef is null by then), so this only fires for edits
	// we did not make.
	// biome-ignore lint/correctness/useExhaustiveDependencies: rescanEpoch intentionally retriggers this guard on every committed rescan.
	useEffect(() => {
		if (dragRef.current) {
			const active = dragRef.current;
			dragRef.current = null;
			active.detachListeners();
			active.session.cancel();
		}
		setMenu((previous) => {
			if (!previous) return previous;
			const stillThere = targets.some((target) => target.uid === previous.uid);
			return stillThere ? previous : null;
		});
		if (hoveredUidRef.current) {
			const stillThere = targets.some(
				(target) => target.uid === hoveredUidRef.current,
			);
			if (!stillThere) setHoveredUid(null);
		}
	}, [rescanEpoch, targets]);

	// R1 — dots disappear when the pointer leaves the editor or the window.
	// Leaving the pane is the same gesture as leaving the table, one step
	// further out, so it gets the same grace period (`HOVER_HIDE_DELAY_MS`) and
	// the same cancellation on the way back in; a window blur is not a gesture
	// at all, and clears at once.
	useEffect(() => {
		const viewport = viewportRef.current;
		let clearTimer: number | null = null;
		const cancelScheduledClear = () => {
			if (clearTimer === null) return;
			window.clearTimeout(clearTimer);
			clearTimer = null;
		};
		const scheduleClear = () => {
			cancelScheduledClear();
			clearTimer = window.setTimeout(() => {
				clearTimer = null;
				setHoveredUid(null);
			}, HOVER_HIDE_DELAY_MS);
		};
		const clearNow = () => {
			cancelScheduledClear();
			setHoveredUid(null);
		};
		viewport?.addEventListener("pointerleave", scheduleClear);
		viewport?.addEventListener("pointerenter", cancelScheduledClear);
		window.addEventListener("blur", clearNow);
		return () => {
			cancelScheduledClear();
			viewport?.removeEventListener("pointerleave", scheduleClear);
			viewport?.removeEventListener("pointerenter", cancelScheduledClear);
			window.removeEventListener("blur", clearNow);
		};
	}, [viewportRef]);

	if (!editor) return null;

	return (
		<>
			{targets.map((target) =>
				createPortal(
					<TableOverlay
						key={target.uid}
						editor={editor}
						target={target}
						editable={editable}
						hovered={hoveredUid === target.uid}
						menu={menu?.uid === target.uid ? menu : null}
						rescanEpoch={rescanEpoch}
						dragRef={dragRef}
						onHover={setHoveredUid}
						onMenu={setMenu}
					/>,
					overlayMountFor(target.wrapperEl),
				),
			)}
		</>
	);
}

/**
 * The NodeView-owned, `contenteditable="false"` mount inside the table's own
 * scroll box. Portalling here (rather than straight into PM-managed DOM)
 * survives the observer's repair flush — the NodeView's `ignoreMutation`
 * agrees to leave this subtree alone. Falls back to the wrapper itself for
 * trees not rendered through the NodeView (unit tests with hand-built DOM).
 */
function overlayMountFor(wrapperEl: HTMLElement): HTMLElement {
	// `:scope >` restricts this to a DIRECT child of this table's own
	// wrapper (the NodeView always appends the mount as `wrapper`'s second
	// child -- see `Table.ts`). A plain descendant query would instead
	// return the first mount in document order, which for a table that
	// contains a nested table in one of its cells is the INNER table's own
	// mount (encountered while walking the outer `<table>` subtree, before
	// the outer wrapper's own mount sibling) -- misdirecting the outer
	// table's dots/menu/expand-control into the nested table's much smaller
	// scroll box (QC8).
	const mount = wrapperEl.querySelector(
		`:scope > [${TABLE_OVERLAY_MOUNT_ATTR}]`,
	);
	return mount instanceof HTMLElement ? mount : wrapperEl;
}

function TableOverlay({
	editor,
	target,
	editable,
	hovered,
	menu,
	rescanEpoch,
	dragRef,
	onHover,
	onMenu,
}: {
	editor: Editor;
	target: TableHandleTarget;
	editable: boolean;
	hovered: boolean;
	menu: DotMenuState | null;
	rescanEpoch: number;
	dragRef: RefObject<ActiveDrag | null>;
	onHover: (uid: string | null) => void;
	onMenu: (menu: DotMenuState | null) => void;
}) {
	const colHandleRef = useRef<HTMLButtonElement | null>(null);
	const rowHandleRef = useRef<HTMLButtonElement | null>(null);
	const colIndicatorRef = useRef<HTMLDivElement | null>(null);
	const rowIndicatorRef = useRef<HTMLDivElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const [hoveredCell, setHoveredCell] = useState<HoveredCell | null>(null);
	// One handle serves every column / row, so a press reads the index from the
	// slot currently on screen rather than from a per-dot prop.
	const slotRef = useRef<HandleSlot>(NO_SLOT);

	// The overlay positions itself against the wrapper's padding box, so the
	// wrapper must be positioned. Set at runtime (never in a stylesheet) and
	// restored on unmount. The chrome frame is installed here too: both handles
	// sit outside the table, and the wrapper's own clip region has to be grown
	// to hold them (`.chrome` in the module CSS does the arithmetic), which
	// means outgrowing the editor's own `max-inline-size: 100%` cap on table
	// wrappers — the attribute below is how that base rule tells a chrome
	// wrapper (and only a chrome wrapper) apart.
	useEffect(() => {
		const wrapper = target.wrapperEl;
		const previousPosition = wrapper.style.position;
		const previousFlowMargin = wrapper.style.getPropertyValue(FLOW_MARGIN_VAR);
		if (getComputedStyle(wrapper).position === "static") {
			wrapper.style.position = "relative";
		}
		wrapper.style.setProperty(
			FLOW_MARGIN_VAR,
			getComputedStyle(wrapper).marginBlockStart || "0px",
		);
		wrapper.classList.add(styles.chrome);
		wrapper.setAttribute(TABLE_CHROME_ATTR, "true");
		return () => {
			wrapper.style.position = previousPosition;
			if (previousFlowMargin)
				wrapper.style.setProperty(FLOW_MARGIN_VAR, previousFlowMargin);
			else wrapper.style.removeProperty(FLOW_MARGIN_VAR);
			wrapper.classList.remove(styles.chrome);
			wrapper.removeAttribute(TABLE_CHROME_ATTR);
		};
	}, [target.wrapperEl]);

	// Real hover detection lives on the wrapper, not the overlay div: the
	// overlay is `pointer-events: none` (so it never steals clicks/selection
	// from the table underneath) and sits as the table's DOM *sibling*, not
	// its ancestor, inside the wrapper -- so a genuine pointer entering the
	// visible table can neither hit-test to the overlay nor bubble up into
	// it. The wrapper spans the same box, keeps `pointer-events: auto`, and
	// is a real ancestor of the table content, so it is the only element
	// that can actually observe the pointer entering/leaving the table.
	//
	// Leaving is delayed (`HOVER_HIDE_DELAY_MS`): a pointer that slips off the
	// table's cells on its way to a handle, the expand chip or the Delete
	// menu used to take the whole chrome with it the instant it crossed the
	// cell edge (the chrome band/gutter is wrapper padding, not a cell, so
	// `hoveredCellFor` returns null there). The clear is scheduled instead,
	// and a pointer coming back onto a cell -- or onto the layer's own chrome
	// -- cancels it. Handles are sticky in the meantime: a move over
	// non-cell wrapper space keeps the last cell's handles up for the grace
	// period rather than clearing them at once.
	useEffect(() => {
		const wrapper = target.wrapperEl;
		let hideTimer: number | null = null;
		const cancelScheduledHide = () => {
			if (hideTimer === null) return;
			window.clearTimeout(hideTimer);
			hideTimer = null;
		};
		const scheduleHide = () => {
			if (hideTimer !== null) return;
			hideTimer = window.setTimeout(() => {
				hideTimer = null;
				onHover(null);
			}, HOVER_HIDE_DELAY_MS);
		};
		const handleEnter = () => {
			cancelScheduledHide();
			onHover(target.uid);
		};
		const handleLeave = () => {
			cancelScheduledHide();
			scheduleHide();
		};
		const handleMove = (event: PointerEvent) => {
			const element = event.target;
			if (!(element instanceof Element)) return;
			// Moving onto the layer's own chrome — a handle, the Delete menu,
			// the expand control — must not clear the handles it just revealed.
			if (element.closest("[data-table-overlay]")) {
				cancelScheduledHide();
				return;
			}
			const next = hoveredCellFor(element, target);
			if (!next) {
				// Off the cells but still inside the wrapper (chrome band,
				// gutter, scroll padding): grace period, not an instant clear.
				scheduleHide();
				return;
			}
			cancelScheduledHide();
			onHover(target.uid);
			setHoveredCell((previous) =>
				sameCell(previous, next) ? previous : next,
			);
		};
		wrapper.addEventListener("pointerenter", handleEnter);
		wrapper.addEventListener("pointerleave", handleLeave);
		wrapper.addEventListener("pointermove", handleMove);
		return () => {
			cancelScheduledHide();
			wrapper.removeEventListener("pointerenter", handleEnter);
			wrapper.removeEventListener("pointerleave", handleLeave);
			wrapper.removeEventListener("pointermove", handleMove);
		};
	}, [target.wrapperEl, target.uid, target, onHover]);

	// Which cell the pointer is over is tracked in the hover effect above
	// (indices only, never geometry — R35).

	// Leaving the table drops the last cell, so re-entering never flashes the
	// previous row's or column's handle before the next pointer move lands.
	useEffect(() => {
		if (!hovered) setHoveredCell(null);
	}, [hovered]);

	// The frozen contract carries document counts, so a column Delete that
	// lands under the pointer can leave the tracked index pointing past the
	// new shape. Clamp here rather than tracking the shape itself.
	const slot = useMemo(
		() => resolveSlot(hovered ? hoveredCell : null, target),
		[hovered, hoveredCell, target],
	);
	slotRef.current = slot;

	// Place the two handles from live cell boxes: one layout read per hovered
	// cell and one per committed rescan — never per pointer move, and the
	// numbers go straight onto the buttons, never into React state (R35).
	// biome-ignore lint/correctness/useExhaustiveDependencies: rescanEpoch intentionally re-places the handles after typing inside the table.
	useEffect(() => {
		if (!editable) return;
		placeHandles(target, slot, colHandleRef.current, rowHandleRef.current);
	}, [editable, slot, rescanEpoch, target]);

	// Dismiss the menu on an outside press without touching anything else on
	// the page (R46 — the composer, format menu and popovers stay mounted).
	useEffect(() => {
		if (!menu) return;
		const onPointerDown = (event: PointerEvent) => {
			if (menuRef.current?.contains(event.target as Node)) return;
			onMenu(null);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				onMenu(null);
			}
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}, [menu, onMenu]);

	const commitDelete = (kind: "column" | "row", index: number) => {
		const pos = findTablePosByUid(editor, target.uid);
		if (pos < 0) {
			onMenu(null);
			return;
		}
		const transaction = tableTransformTransaction(
			editor.state,
			pos,
			kind === "column"
				? (table) => deleteTableColumn(table, index)
				: (table) => deleteTableRow(table, index),
		);
		onMenu(null);
		// R8 — a delete with nowhere to go (only column / only row raced away
		// underneath us) dispatches nothing.
		if (transaction) editor.view.dispatch(transaction);
		focusEditorWithoutScroll(editor);
	};

	const beginDotPress = (
		event: ReactPointerEvent<HTMLButtonElement>,
		kind: "column" | "row",
	) => {
		if (!editable || event.button !== 0) return;
		// R14 — a handle press is never an editor drag, a drop, or a
		// margin-click-to-end: no HTML5 DnD starts here and the editor's own
		// pointer handlers never see the press.
		event.preventDefault();
		event.stopPropagation();
		if (dragRef.current) return;
		const current = slotRef.current;
		const index = kind === "column" ? current.column : current.row;
		// A handle that is on screen with no index behind it (a shape edit
		// clamped it away) writes nothing (R8).
		if (index === null) return;

		const capture = captureDragGeometry(target, kind);
		if (!capture) return;
		const button = event.currentTarget;
		try {
			button.setPointerCapture(event.pointerId);
		} catch {
			// Pointer capture is a nicety; the window listeners below carry
			// the drag either way.
		}

		const indicator =
			kind === "column" ? colIndicatorRef.current : rowIndicatorRef.current;
		const axisOf = (clientX: number, clientY: number) =>
			kind === "column" ? clientX : clientY;
		const active: ActiveDrag = {
			session: TableHandleDrag.begin({
				kind,
				fromIndex: index,
				itemCount: capture.itemCount,
				slotEdges: capture.slotEdges,
				originClient: capture.originClient,
				startClient: axisOf(event.clientX, event.clientY),
				callbacks: {
					onIndicator: (slot) => {
						if (!indicator) return;
						if (slot === null) {
							indicator.dataset.visible = "false";
							return;
						}
						indicator.dataset.visible = "true";
						const edge = capture.slotEdges[slot] ?? 0;
						if (kind === "column") {
							indicator.style.insetInlineStart = `${edge}px`;
						} else {
							indicator.style.top = `${edge}px`;
						}
					},
					onEnd: (end) => {
						dragRef.current = null;
						active.detachListeners();
						try {
							button.releasePointerCapture(event.pointerId);
						} catch {
							// Already released (pointerup auto-releases).
						}
						if (end.kind === "click") {
							openMenuForDot(target, kind, index, button, onMenu);
						} else if (end.kind === "commit") {
							commitMove(editor, target.uid, kind, index, end.toIndex);
						}
						// "cancel" writes nothing by construction (R8).
					},
				},
			}),
			uid: target.uid,
			kind,
			fromIndex: index,
			itemCount: capture.itemCount,
			indicator,
			slotEdges: capture.slotEdges,
			detachListeners: () => {},
		};
		const onPointerMove = (moveEvent: PointerEvent) => {
			active.session.handleMove(axisOf(moveEvent.clientX, moveEvent.clientY));
		};
		const onPointerUp = (upEvent: PointerEvent) => {
			active.session.handleUp(axisOf(upEvent.clientX, upEvent.clientY));
		};
		const onCancel = () => active.session.cancel();
		// R13 — the drag's Escape listener exists only while the button is
		// held; cancelling hands Escape straight back to the find bar and
		// the slash menu.
		const onKeyDown = (keyEvent: KeyboardEvent) => {
			if (keyEvent.key === "Escape") {
				keyEvent.stopPropagation();
				active.session.cancel();
			}
		};
		const detachListeners = () => {
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("pointercancel", onCancel);
			window.removeEventListener("blur", onCancel);
			window.removeEventListener("keydown", onKeyDown, true);
		};
		active.detachListeners = detachListeners;
		dragRef.current = active;
		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", onPointerUp);
		window.addEventListener("pointercancel", onCancel);
		window.addEventListener("blur", onCancel);
		window.addEventListener("keydown", onKeyDown, true);
	};

	return (
		<div
			className={styles.overlay}
			data-table-overlay={target.uid}
			data-hovered={hovered}
		>
			{editable && slot.column !== null ? (
				<button
					ref={colHandleRef}
					type="button"
					draggable={false}
					tabIndex={-1}
					className={styles.colHandle}
					data-table-col-handle=""
					data-col={slot.column}
					aria-label={`Reorder column ${slot.column + 1}`}
					onPointerDown={(event) => beginDotPress(event, "column")}
					onDragStart={(event) => event.preventDefault()}
				>
					<GripDots />
				</button>
			) : null}
			{editable && slot.row !== null ? (
				<button
					ref={rowHandleRef}
					type="button"
					draggable={false}
					tabIndex={-1}
					className={styles.rowHandle}
					data-table-row-handle=""
					data-row={slot.row}
					aria-label={`Reorder row ${slot.row + 1}`}
					onPointerDown={(event) => beginDotPress(event, "row")}
					onDragStart={(event) => event.preventDefault()}
				>
					<GripDots />
				</button>
			) : null}
			<div
				ref={colIndicatorRef}
				className={styles.colIndicator}
				data-visible="false"
				aria-hidden="true"
			/>
			<div
				ref={rowIndicatorRef}
				className={styles.rowIndicator}
				data-visible="false"
				aria-hidden="true"
			/>
			{menu ? (
				<div
					ref={menuRef}
					className={styles.menu}
					role="menu"
					style={{
						insetInlineStart: `${menu.anchorInline}px`,
						top: `${menu.anchorTop}px`,
					}}
				>
					<button
						type="button"
						role="menuitem"
						className={styles.menuItem}
						data-table-delete=""
						onPointerDown={(event) => {
							event.stopPropagation();
						}}
						onClick={(event) => {
							event.stopPropagation();
							commitDelete(menu.kind, menu.index);
						}}
					>
						Delete
					</button>
				</div>
			) : null}
			{/* Slice 2 owns this control; slice 1 only mounts it per table with
			exactly these props. It renders even on a read-only surface (R45). */}
			<TableWidthControl
				editor={editor}
				target={sliceTarget(target)}
				hovered={hovered}
			/>
		</div>
	);
}

/** The six-dot grip both handles are drawn with: two columns by three rows. */
function GripDots() {
	return (
		<span className={styles.gripDots} aria-hidden="true">
			{Array.from({ length: GRIP_DOT_COUNT }, (_, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: the grip's dots are six identical decorative slots, never reordered.
				<span key={index} className={styles.gripDot} />
			))}
		</span>
	);
}

/** The frozen slice contract carries only uid/pos/elements — strip our counts. */
function sliceTarget(target: TableHandleTarget): TableTarget {
	return {
		uid: target.uid,
		pos: target.pos,
		tableEl: target.tableEl,
		wrapperEl: target.wrapperEl,
	};
}

function findTablePosByUid(editor: Editor, uid: string): number {
	let found = -1;
	editor.state.doc.descendants((node, pos) => {
		if (found >= 0) return false;
		if (
			node.type.name === "table" &&
			(node.attrs as { uid?: unknown }).uid === uid
		) {
			found = pos;
			return false;
		}
		return true;
	});
	return found;
}

/** One gesture = one transaction = one Cmd+Z (R10). Null writes nothing (R8). */
function commitMove(
	editor: Editor,
	uid: string,
	kind: "column" | "row",
	fromIndex: number,
	toIndex: number,
): void {
	const pos = findTablePosByUid(editor, uid);
	if (pos < 0) return;
	const transaction = tableTransformTransaction(
		editor.state,
		pos,
		kind === "column"
			? (table) => moveTableColumn(table, fromIndex, toIndex)
			: (table) => moveTableRow(table, fromIndex, toIndex),
	);
	if (transaction) editor.view.dispatch(transaction);
	focusEditorWithoutScroll(editor);
}

/** R15 — the editor keeps focus after a committed gesture, without jumping. */
function focusEditorWithoutScroll(editor: Editor): void {
	try {
		(editor.view.dom as HTMLElement).focus({ preventScroll: true });
	} catch {
		// Focusing is a nicety; the committed selection already landed valid.
	}
}

type DragCapture = {
	itemCount: number;
	slotEdges: number[];
	originClient: number;
};

/**
 * Snapshot the drag's pixel boundaries once at press time (R38): column slot
 * edges from the header cells' right edges (falling back to even splits when
 * the DOM disagrees with the shape, e.g. a ragged table), row slot edges
 * from the body rows' bottom edges. Rows are body-only — the header can
 * never be a drop target (R3).
 */
function captureDragGeometry(
	target: TableHandleTarget,
	kind: "column" | "row",
): DragCapture | null {
	const wrapperRect = target.wrapperEl.getBoundingClientRect();
	const table = target.tableEl;
	const rows = table.rows ? Array.from(table.rows) : [];
	if (kind === "column") {
		const itemCount = target.columnCount;
		const headerCells = rows.length > 0 ? Array.from(rows[0].cells) : [];
		let edges: number[];
		if (headerCells.length >= itemCount && headerCells.length > 0) {
			edges = [0];
			for (const cell of headerCells.slice(0, itemCount)) {
				const rect = cell.getBoundingClientRect();
				edges.push(rect.right - wrapperRect.left + target.wrapperEl.scrollLeft);
			}
			edges[0] = 0;
		} else {
			const tableRect = table.getBoundingClientRect();
			const width =
				tableRect.width > 0 ? tableRect.width : Math.max(itemCount, 1) * 100;
			const start =
				tableRect.left - wrapperRect.left + target.wrapperEl.scrollLeft;
			edges = evenSlotEdges(itemCount, width).map((edge) => start + edge);
		}
		return {
			itemCount,
			slotEdges: edges,
			originClient: wrapperRect.left,
		};
	}
	const bodyRows = rows.slice(1, 1 + target.bodyRowCount);
	if (bodyRows.length === 0 || target.bodyRowCount === 0) return null;
	const edges = [
		bodyRows[0].getBoundingClientRect().top -
			wrapperRect.top +
			target.wrapperEl.scrollTop,
	];
	for (const row of bodyRows) {
		const rect = row.getBoundingClientRect();
		edges.push(rect.bottom - wrapperRect.top + target.wrapperEl.scrollTop);
	}
	return {
		itemCount: target.bodyRowCount,
		slotEdges: edges,
		originClient: wrapperRect.top,
	};
}

/**
 * Write the two handles' positions straight onto their buttons (R35). The
 * column pill is centred over the hovered column and pinned to the table's
 * own top edge — which is `CHROME_BAND_PX` below the wrapper's padding box,
 * inside the reserved band — so it straddles the border exactly like the
 * reference design. The row grip is centred in the hovered body row's left
 * gutter. Both live inside the wrapper's scroll box, so they are visible even
 * when the table is the document's first block (R1) and track scrolling by
 * CSS (R36).
 */
function placeHandles(
	target: TableHandleTarget,
	slot: HandleSlot,
	colHandle: HTMLButtonElement | null,
	rowHandle: HTMLButtonElement | null,
): void {
	const wrapperRect = target.wrapperEl.getBoundingClientRect();
	const rows = target.tableEl.rows ? Array.from(target.tableEl.rows) : [];
	if (slot.column !== null && colHandle) {
		const headerCells = rows.length > 0 ? Array.from(rows[0].cells) : [];
		const widest = widestCellList(rows);
		const cell =
			headerCells[slot.column] ??
			widest[slot.column % Math.max(widest.length, 1)];
		if (cell) {
			const rect = cell.getBoundingClientRect();
			const centre =
				(rect.left + rect.right) / 2 -
				wrapperRect.left +
				target.wrapperEl.scrollLeft;
			colHandle.style.insetInlineStart = `${centre}px`;
		}
	}
	if (slot.row !== null && rowHandle) {
		const row = rows[1 + slot.row];
		if (row) {
			const rect = row.getBoundingClientRect();
			const middle =
				(rect.top + rect.bottom) / 2 -
				wrapperRect.top +
				target.wrapperEl.scrollTop;
			rowHandle.style.top = `${middle}px`;
		}
	}
}

/**
 * The cell the pointer is over, in document terms. Header cells carry the
 * column only — the header can never be a row-drop target (R3) — and a table
 * nested inside a cell is never a handle target at all (R16).
 */
function hoveredCellFor(
	element: Element,
	target: TableHandleTarget,
): HoveredCell | null {
	const cell = element.closest("td, th");
	if (!(cell instanceof HTMLTableCellElement)) return null;
	if (cell.closest("table") !== target.tableEl) return null;
	const row = cell.closest("tr");
	if (!(row instanceof HTMLTableRowElement)) return null;
	const column = cell.cellIndex;
	if (column < 0) return null;
	const isBodyRow = cell.tagName === "TD" && row.rowIndex >= 1;
	return { column, row: isBodyRow ? row.rowIndex - 1 : null };
}

function sameCell(a: HoveredCell | null, b: HoveredCell | null): boolean {
	if (!a || !b) return a === b;
	return a.column === b.column && a.row === b.row;
}

/** Drop whichever of the tracked indices the table's current shape no longer has. */
function resolveSlot(
	cell: HoveredCell | null,
	target: TableHandleTarget,
): HandleSlot {
	if (!cell) return NO_SLOT;
	return {
		column: cell.column < target.columnCount ? cell.column : null,
		row: cell.row !== null && cell.row < target.bodyRowCount ? cell.row : null,
	};
}

function widestCellList(rows: HTMLTableRowElement[]): HTMLTableCellElement[] {
	let widest: HTMLTableCellElement[] = [];
	for (const row of rows) {
		const cells = Array.from(row.cells);
		if (cells.length > widest.length) widest = cells;
	}
	return widest;
}

/** Click (no drag) opens the small menu whose only item is Delete (R4). */
function openMenuForDot(
	target: TableHandleTarget,
	kind: "column" | "row",
	index: number,
	dot: HTMLButtonElement,
	onMenu: (menu: DotMenuState | null) => void,
): void {
	const wrapperRect = target.wrapperEl.getBoundingClientRect();
	const dotRect = dot.getBoundingClientRect();
	onMenu({
		uid: target.uid,
		kind,
		index,
		anchorInline: dotRect.left - wrapperRect.left + target.wrapperEl.scrollLeft,
		anchorTop: dotRect.bottom - wrapperRect.top + target.wrapperEl.scrollTop,
	});
}
