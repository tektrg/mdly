import type { Editor } from "@tiptap/react";
import {
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useEffect,
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
 * Slice 1 — hover dots, drag-to-reorder, dot menu Delete.
 *
 * The layer discovers every GFM table (docChanged-gated, rAF-coalesced — see
 * `useTableTargets`) and portals one overlay into the NodeView-owned mount
 * inside each table's own `.tableWrapper` scroll box (charter R36), so dots track scrolling, resize
 * and panel toggles by CSS with no scroll/resize listeners. Dots are drawn,
 * never inserted: hovering reads layout only while the pointer is over a
 * table (R35), a drag reads no layout per move (R38), and anything short of
 * a real drop or Delete dispatches nothing at all (R8).
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
	useEffect(() => {
		const viewport = viewportRef.current;
		const clearHover = () => setHoveredUid(null);
		viewport?.addEventListener("pointerleave", clearHover);
		window.addEventListener("blur", clearHover);
		return () => {
			viewport?.removeEventListener("pointerleave", clearHover);
			window.removeEventListener("blur", clearHover);
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
	const colDotsRef = useRef<(HTMLButtonElement | null)[]>([]);
	const rowDotsRef = useRef<(HTMLButtonElement | null)[]>([]);
	const colIndicatorRef = useRef<HTMLDivElement | null>(null);
	const rowIndicatorRef = useRef<HTMLDivElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);

	// The overlay positions itself against the wrapper's padding box, so the
	// wrapper must be positioned. Set at runtime (never in a stylesheet) and
	// restored on unmount.
	useEffect(() => {
		const wrapper = target.wrapperEl;
		const previous = wrapper.style.position;
		if (getComputedStyle(wrapper).position === "static") {
			wrapper.style.position = "relative";
		}
		return () => {
			wrapper.style.position = previous;
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
	useEffect(() => {
		const wrapper = target.wrapperEl;
		const handleEnter = () => onHover(target.uid);
		const handleLeave = () => onHover(null);
		wrapper.addEventListener("pointerenter", handleEnter);
		wrapper.addEventListener("pointerleave", handleLeave);
		return () => {
			wrapper.removeEventListener("pointerenter", handleEnter);
			wrapper.removeEventListener("pointerleave", handleLeave);
		};
	}, [target.wrapperEl, target.uid, onHover]);

	// Place dots from live cell boxes: one layout read per hover-enter and
	// one per committed rescan while hovered — never per pointer move, and
	// the numbers go straight onto the buttons, never into React state (R35).
	// biome-ignore lint/correctness/useExhaustiveDependencies: rescanEpoch intentionally re-places hovered dots after typing inside the table.
	useEffect(() => {
		if (!hovered || !editable) return;
		placeDots(target, colDotsRef.current, rowDotsRef.current);
	}, [hovered, editable, rescanEpoch, target]);

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
		index: number,
	) => {
		if (!editable || event.button !== 0) return;
		// R14 — a handle press is never an editor drag, a drop, or a
		// margin-click-to-end: no HTML5 DnD starts here and the editor's own
		// pointer handlers never see the press.
		event.preventDefault();
		event.stopPropagation();
		if (dragRef.current) return;

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
			{editable
				? Array.from({ length: target.columnCount }, (_, index) => (
						<button
							// biome-ignore lint/suspicious/noArrayIndexKey: dots are positional — one per column slot, re-placed imperatively by the same index.
							key={`col-${index}`}
							ref={(el) => {
								colDotsRef.current[index] = el;
							}}
							type="button"
							draggable={false}
							tabIndex={-1}
							className={styles.colDot}
							data-table-col-handle=""
							data-col={index}
							aria-label={`Reorder column ${index + 1}`}
							onPointerDown={(event) => beginDotPress(event, "column", index)}
							onDragStart={(event) => event.preventDefault()}
						/>
					))
				: null}
			{editable
				? Array.from({ length: target.bodyRowCount }, (_, index) => (
						<button
							// biome-ignore lint/suspicious/noArrayIndexKey: dots are positional — one per body-row slot, re-placed imperatively by the same index.
							key={`row-${index}`}
							ref={(el) => {
								rowDotsRef.current[index] = el;
							}}
							type="button"
							draggable={false}
							tabIndex={-1}
							className={styles.rowDot}
							data-table-row-handle=""
							data-row={index}
							aria-label={`Reorder row ${index + 1}`}
							onPointerDown={(event) => beginDotPress(event, "row", index)}
							onDragStart={(event) => event.preventDefault()}
						/>
					))
				: null}
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
 * Write every dot's position straight onto its button (R35): column dots
 * centred over their column at the table's top edge, row dots in the left
 * gutter centred on their body row. Dots sit fully inside the wrapper's
 * scroll box, so they are visible even when the table is the document's
 * first block (R1) and track scrolling by CSS (R36).
 */
function placeDots(
	target: TableHandleTarget,
	colDots: (HTMLButtonElement | null)[],
	rowDots: (HTMLButtonElement | null)[],
): void {
	const wrapperRect = target.wrapperEl.getBoundingClientRect();
	const rows = target.tableEl.rows ? Array.from(target.tableEl.rows) : [];
	if (rows.length > 0) {
		const headerCells = Array.from(rows[0].cells);
		const widest = widestCellList(rows);
		for (let index = 0; index < target.columnCount; index += 1) {
			const dot = colDots[index];
			if (!dot) continue;
			const cell =
				headerCells[index] ?? widest[index % Math.max(widest.length, 1)];
			if (!cell) continue;
			const rect = cell.getBoundingClientRect();
			const center =
				(rect.left + rect.right) / 2 -
				wrapperRect.left +
				target.wrapperEl.scrollLeft;
			dot.style.insetInlineStart = `${center}px`;
		}
	}
	const bodyRows = rows.slice(1, 1 + target.bodyRowCount);
	for (let index = 0; index < bodyRows.length; index += 1) {
		const dot = rowDots[index];
		const row = bodyRows[index];
		if (!dot || !row) continue;
		const rect = row.getBoundingClientRect();
		const middle =
			(rect.top + rect.bottom) / 2 -
			wrapperRect.top +
			target.wrapperEl.scrollTop;
		dot.style.top = `${middle}px`;
	}
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
