import { useCallback, useEffect, useState } from "react";
import styles from "./TableWidthControl.module.css";
import {
	acquirePaneContainer,
	isTableExpanded,
	nudgeTableOverlays,
	setTableExpanded,
} from "./tableFullWidth.js";
import type { TableWidthControlProps } from "./tableInteractionTypes.js";

/**
 * Slice 2 — per-table full-width expand/collapse control (charter R19–R25).
 *
 * Rendered once per table by `TableInteractionLayer`, inside that table's own
 * `.tableWrapper` scroll box. Shown on hover; once expanded it stays visible
 * until collapsed again (R19). Toggling flips a CSS class on the wrapper and
 * records the table's session uid in memory — it never dispatches a
 * transaction and never touches the document, so the file stays byte-identical
 * (R23) and sibling tables are unaffected (state is keyed by `target.uid`).
 * After each toggle it emits the feature-local overlay re-measure nudge (R25).
 */
export function TableWidthControl({
	editor,
	target,
	hovered,
}: TableWidthControlProps) {
	const [expanded, setExpanded] = useState(() => isTableExpanded(target.uid));

	// The layer may reuse this instance across rescans: a new uid means a
	// different table, which starts from the session store (collapsed unless
	// this exact table was expanded before).
	useEffect(() => {
		setExpanded(isTableExpanded(target.uid));
	}, [target.uid]);

	useEffect(() => {
		const wrapper = target.wrapperEl;
		wrapper.classList.add(styles.anchored);
		// The pane becomes the `100cqi` query container for the width rule.
		// Graceful without it (a detached test tree): the toggle still flips
		// state and the class, only the live pane measurement degrades.
		const pane = wrapper.closest(".editorViewport");
		const release =
			pane instanceof HTMLElement ? acquirePaneContainer(pane) : undefined;
		return () => {
			release?.();
			wrapper.classList.remove(styles.anchored, styles.fullWidth);
			wrapper.removeAttribute("data-table-full-width");
		};
	}, [target.wrapperEl]);

	useEffect(() => {
		target.wrapperEl.classList.toggle(styles.fullWidth, expanded);
		if (expanded)
			target.wrapperEl.setAttribute("data-table-full-width", "true");
		else target.wrapperEl.removeAttribute("data-table-full-width");
	}, [expanded, target.wrapperEl]);

	const toggle = useCallback(() => {
		const next = !expanded;
		setTableExpanded(target.uid, next);
		setExpanded(next);
		// The editor's typed `emit` demands a real `Transaction`; the nudge is
		// intentionally synthetic (see `nudgeTableOverlays`), so cross the
		// boundary here, once, instead of widening the helper's type.
		nudgeTableOverlays(
			editor as unknown as { emit(event: string, payload?: unknown): void },
		);
	}, [editor, expanded, target.uid]);

	const visible = hovered || expanded;

	return (
		<div
			className={styles.control}
			data-visible={visible ? "true" : "false"}
			data-expanded={expanded ? "true" : "false"}
			aria-hidden={visible ? undefined : "true"}
		>
			<button
				type="button"
				className={styles.button}
				aria-expanded={expanded}
				aria-label={
					expanded
						? "Collapse table to text width"
						: "Expand table to full width"
				}
				title={expanded ? "Collapse table" : "Expand table"}
				tabIndex={visible ? 0 : -1}
				onClick={toggle}
				// Keep the press from starting the layer's own pointer gestures:
				// this button toggles a look, never a drag (charter R14-adjacent).
				onPointerDown={(event) => event.stopPropagation()}
				// Keep editor focus (and the caret) where it was: the toggle is a
				// chrome affordance, not an edit, so it takes no focus on click.
				// Keyboard users still reach it by tab — see `tabIndex` above.
				onMouseDown={(event) => event.preventDefault()}
			>
				{expanded ? "Collapse" : "Expand"}
			</button>
		</div>
	);
}
