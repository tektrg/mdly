import type { Editor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
// @ts-expect-error The kit does not ship react-dom types (same precedent as
// TableInteractionLayer's createPortal import); react-dom itself is a real
// dependency so this resolves at runtime and in the bundler.
import { createPortal } from "react-dom";
import {
	cellPickTransaction,
	focusedCellValue,
	inferColumnValues,
	isPlainTextCell,
	pickTargetAtSelection,
} from "../inferredSelect.js";
import {
	createValuePickerPlugin,
	inferredSelectPluginKey,
} from "../inferredSelectPlugin.js";
import { pastelForValue } from "../pastelForValue.js";
import styles from "./TableValuePicker.module.css";
import type { TableValuePickerProps } from "./tableInteractionTypes.js";

/**
 * Logical menu state — document positions and offered strings only. Pixel
 * geometry is written straight onto the menu element when it opens and never
 * lands in React state (charter R35).
 */
type ValueOffer = {
	tablePos: number;
	cellPos: number;
	columnIndex: number;
	values: string[];
	current: string;
};

/**
 * Slice 3 — inferred select chevron on a focused cell (charter R26–R32).
 *
 * Mounted by `EditorView` behind the opt-in prop — and only when editable —
 * so inertness on the web apps is structural, never a runtime check (R33,
 * R45). The chevron itself is a ProseMirror widget decoration registered by
 * this component (see `inferredSelectPlugin.ts`): ProseMirror treats foreign
 * DOM appended inside its managed tree as corruption and re-renders the node
 * on its next observer flush, so a React portal into the table's
 * `.tableWrapper` is wiped within a frame — a decoration is ProseMirror's own
 * rendering and is never wiped, needs no geometry, and tracks every layout
 * change by construction (R35, R36, R38). The dropdown menu portals into the
 * editor viewport container, which React owns, so it is outside ProseMirror's
 * reach entirely.
 *
 * Picking a value is an ordinary cell text edit that reaches the file (R26).
 * The chevron never takes focus, registers no keyboard shortcuts, and stays
 * out of every key's way (R30).
 */
export function TableValuePicker({
	editor,
	viewportRef,
}: TableValuePickerProps) {
	const [offer, setOffer] = useState<ValueOffer | null>(null);
	const [openFor, setOpenFor] = useState<string | null>(null);
	const editorRef = useRef(editor);
	editorRef.current = editor;
	const toggleRef = useRef(() => {});
	toggleRef.current = () => {
		const live = editorRef.current;
		if (!live || live.isDestroyed) return;
		const target = pickTargetAtSelection(live.state);
		if (!target) return;
		const key = offerKey(target);
		setOpenFor((previous) => (previous === key ? null : key));
	};

	// The chevron decoration lives and dies with this component: registering
	// here (rather than in the shared editor extensions) is what keeps the
	// web apps inert without a runtime check (R33).
	useEffect(() => {
		if (!editor || editor.isDestroyed) return;
		const toggle = () => toggleRef.current();
		const { plugin, dispose } = createValuePickerPlugin(toggle);
		editor.registerPlugin(plugin);
		return () => {
			editor.unregisterPlugin(inferredSelectPluginKey);
			dispose();
		};
	}, [editor]);

	// R34/R37 + R42 — the menu's logical state recomputes only on a real
	// document change or a caret-cell change, coalesced to at most once per
	// frame. Any document change also drops an open menu instead of acting on
	// stale indices (R42). Selection-only and plugin-meta-only transactions
	// that stay in the same cell schedule nothing at all.
	useEffect(() => {
		if (!editor) return;
		let frame = 0;
		let lastCellKey: string | null = null;
		let disposed = false;

		const readOffer = (): ValueOffer | null => {
			const live = editorRef.current;
			if (!live || live.isDestroyed) return null;
			// R35 — a document with no tables costs one boolean scan and no
			// layout read whatsoever.
			let hasTable = false;
			live.state.doc.descendants((node) => {
				if (node.type.name === "table") {
					hasTable = true;
					return false;
				}
				return true;
			});
			if (!hasTable) return null;
			const target = pickTargetAtSelection(live.state);
			if (!target) return null;
			const table = live.state.doc.nodeAt(target.tablePos);
			const cell = live.state.doc.nodeAt(target.cellPos);
			if (!table || !cell || table.type.name !== "table") return null;
			const cellJson = cell.toJSON();
			// R29 — anything but plain text is edited by typing only.
			if (!isPlainTextCell(cellJson)) return null;
			const values = inferColumnValues(table.toJSON(), target.columnIndex);
			if (values.length === 0) return null;
			return {
				tablePos: target.tablePos,
				cellPos: target.cellPos,
				columnIndex: target.columnIndex,
				values,
				current: focusedCellValue(cellJson) ?? "",
			};
		};

		const commit = () => {
			if (disposed) return;
			const next = readOffer();
			lastCellKey = next ? offerKey(next) : selectionCellKey();
			// Ignition guard: setting an equal offer twice dispatches no
			// second render (R34).
			setOffer((previous) => (sameOffer(previous, next) ? previous : next));
		};

		const selectionCellKey = (): string | null => {
			const target = pickTargetAtSelection(editor.state);
			return target ? offerKey(target) : null;
		};

		const schedule = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				commit();
			});
		};

		const onTransaction = ({
			transaction,
		}: {
			transaction?: { docChanged?: boolean };
		}) => {
			if (transaction?.docChanged) {
				setOpenFor(null);
				lastCellKey = null;
				schedule();
				return;
			}
			const cellKey = selectionCellKey();
			if (cellKey !== lastCellKey) {
				lastCellKey = cellKey;
				setOpenFor(null);
				schedule();
			}
		};

		commit();
		editor.on("transaction", onTransaction);
		editor.on("selectionUpdate", onTransaction);
		return () => {
			disposed = true;
			if (frame) cancelAnimationFrame(frame);
			editor.off("transaction", onTransaction);
			editor.off("selectionUpdate", onTransaction);
		};
	}, [editor]);

	// Keep the widget's expanded state honest for assistive tech. The
	// chevron is plugin-owned DOM; this is an attribute write, not geometry.
	useEffect(() => {
		if (!editor || editor.isDestroyed) return;
		const chevron = editor.view.dom.querySelector("[data-table-value-chevron]");
		if (chevron instanceof HTMLElement) {
			chevron.setAttribute(
				"aria-expanded",
				openFor !== null ? "true" : "false",
			);
		}
	}, [editor, openFor]);

	// R30 — Escape stays with the editor, the find bar and the slash menu at
	// all times: this closes the list without consuming the key (no
	// preventDefault, no stopPropagation), so every existing Escape behaviour
	// fires exactly as it does on an ordinary cell.
	useEffect(() => {
		if (!editor || openFor === null) return;
		const dom = editor.view.dom;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpenFor(null);
		};
		dom.addEventListener("keydown", onKeyDown);
		return () => dom.removeEventListener("keydown", onKeyDown);
	}, [editor, openFor]);

	// An open menu is a momentary guest: a press anywhere outside it, the
	// pointer leaving the editor, or the window losing focus dismisses it.
	// Nothing else on the page is touched (R46).
	useEffect(() => {
		if (openFor === null) return;
		const viewport = viewportRef.current;
		const close = () => setOpenFor(null);
		viewport?.addEventListener("pointerleave", close);
		window.addEventListener("blur", close);
		return () => {
			viewport?.removeEventListener("pointerleave", close);
			window.removeEventListener("blur", close);
		};
	}, [viewportRef, openFor]);

	const viewportEl = viewportRef.current;
	if (!editor || !offer || openFor !== offerKey(offer) || !viewportEl) {
		return null;
	}

	return createPortal(
		<ValueMenu
			editor={editor}
			viewportEl={viewportEl}
			offer={offer}
			onDismiss={() => setOpenFor(null)}
			onPick={(value) => {
				const live = editorRef.current;
				setOpenFor(null);
				if (!live || live.isDestroyed) return;
				// Re-resolve against the live document — never act on the
				// indices the offer was computed from (R42).
				const target = pickTargetAtSelection(live.state);
				if (
					!target ||
					target.tablePos !== offer.tablePos ||
					target.cellPos !== offer.cellPos
				) {
					return;
				}
				const transaction = cellPickTransaction(live.state, target, value);
				// R31 — a same-value pick returns no transaction: nothing is
				// dispatched, so there is no rewrite, no revision, no undo step.
				if (transaction) live.view.dispatch(transaction);
			}}
		/>,
		viewportEl,
	);
}

function ValueMenu({
	editor,
	viewportEl,
	offer,
	onDismiss,
	onPick,
}: {
	editor: Editor;
	viewportEl: HTMLElement;
	offer: ValueOffer;
	onDismiss: () => void;
	onPick: (value: string) => void;
}) {
	const menuRef = useRef<HTMLDivElement | null>(null);

	// Place the menu once, when it opens, from the chevron widget's live box:
	// one layout read per open, never per pointer move (R38-adjacent), and
	// the numbers go straight onto the element, never into React state (R35).
	// The menu lives in the viewport container, so page scroll, window
	// resize and panel toggles move it together with the table by CSS; only
	// sideways scrolling inside the table while open can detach it, and any
	// caret move or edit closes it first.
	useEffect(() => {
		const menu = menuRef.current;
		const chevron = editor.view.dom.querySelector("[data-table-value-chevron]");
		if (!menu || !(chevron instanceof HTMLElement)) return;
		const viewportRect = viewportEl.getBoundingClientRect();
		const rect = chevron.getBoundingClientRect();
		const menuWidth = menu.offsetWidth || 160;
		const maxStart = viewportRect.width - menuWidth - 4;
		const want =
			rect.right - viewportRect.left + viewportEl.scrollLeft - menuWidth;
		menu.style.insetBlockStart = `${rect.bottom - viewportRect.top + viewportEl.scrollTop + 2}px`;
		menu.style.insetInlineStart = `${Math.max(4, Math.min(want, maxStart))}px`;
		// The menu mounts fresh on every open, so mount-time placement is
		// enough — no dependency on the offer itself.
	}, [editor, viewportEl]);

	// Dismiss on an outside press. Capture-phase, contains-checked, never
	// stopped: the composer, format menu and popovers never notice (R46).
	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			if (menuRef.current?.contains(event.target as Node)) return;
			const chevron = editor.view.dom.querySelector(
				"[data-table-value-chevron]",
			);
			if (
				chevron instanceof HTMLElement &&
				chevron.contains(event.target as Node)
			) {
				return;
			}
			onDismiss();
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		return () =>
			document.removeEventListener("pointerdown", onPointerDown, true);
	}, [editor, onDismiss]);

	return (
		<div
			ref={menuRef}
			className={styles.menu}
			role="listbox"
			data-table-value-menu=""
		>
			{offer.values.map((value) => {
				const pastel = pastelForValue(value);
				return (
					<button
						key={value}
						type="button"
						tabIndex={-1}
						role="option"
						aria-selected={value === offer.current}
						className={styles.menuItem}
						data-current={value === offer.current}
						title={value}
						style={{
							backgroundColor: pastel.background,
							borderColor: pastel.border,
							color: pastel.text,
						}}
						onMouseDown={(event) => {
							// The caret never leaves the cell; the menu never
							// takes focus (R30).
							event.preventDefault();
						}}
						onClick={(event) => {
							event.stopPropagation();
							onPick(value);
						}}
						onDragStart={(event) => event.preventDefault()}
					>
						{value}
					</button>
				);
			})}
		</div>
	);
}

function offerKey(offer: Pick<ValueOffer, "tablePos" | "cellPos">): string {
	return `${offer.tablePos}:${offer.cellPos}`;
}

function sameOffer(
	previous: ValueOffer | null,
	next: ValueOffer | null,
): boolean {
	if (previous === next) return true;
	if (!previous || !next) return false;
	return (
		previous.tablePos === next.tablePos &&
		previous.cellPos === next.cellPos &&
		previous.columnIndex === next.columnIndex &&
		previous.current === next.current &&
		previous.values.length === next.values.length &&
		previous.values.every((value, index) => value === next.values[index])
	);
}
