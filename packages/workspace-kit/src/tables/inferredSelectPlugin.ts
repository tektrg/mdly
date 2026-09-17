import type { EditorState } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
	focusedCellValue,
	inferColumnValues,
	isPlainTextCell,
	pickTargetAtSelection,
} from "./inferredSelect.js";
import styles from "./ui/TableValuePicker.module.css";

/**
 * Slice 3 — the chevron as a ProseMirror widget decoration (charter R26–R30).
 *
 * Why a decoration and not a React portal: ProseMirror treats any foreign DOM
 * appended inside its managed tree as corruption and re-renders the node on
 * its next observer flush — a portal into the table's `.tableWrapper` is
 * wiped within a frame, with no transaction and no error (reproduced in
 * `inferredSelectDebug.test.ts`, since removed). A widget decoration is
 * ProseMirror's own rendering, so it is never wiped, never needs geometry,
 * never needs scroll or resize listeners, and tracks every layout change by
 * construction (R35, R36, R38 all satisfied structurally).
 *
 * The plugin carries no state and registers no keymap (R30): decorations are
 * derived from the live selection on every state update, exactly like the
 * comment-mark plugin. A pick never acts on stale positions — the click
 * handler only notifies React, which re-resolves the target from the live
 * document before committing (R42).
 */

export const inferredSelectPluginKey = new PluginKey("mdlyInferredSelect");

type ChevronDom = {
	key: string;
	button: HTMLButtonElement;
	cleanup: () => void;
};

/**
 * Register the chevron decoration on a live editor. `onChevronToggle` fires
 * when the chevron is clicked; it must be ref-stable for the plugin's
 * lifetime (registration happens once per mount). The returned `dispose`
 * drops the cached button's listeners; call it when unregistering.
 */
export function createValuePickerPlugin(onChevronToggle: () => void): {
	plugin: Plugin;
	dispose: () => void;
} {
	// One live button per focused cell: rebuilt only when the caret moves to
	// a different cell, never per keystroke within it.
	let cached: ChevronDom | null = null;

	const buttonFor = (key: string, values: string[]): HTMLButtonElement => {
		if (cached && cached.key === key && cached.button.isConnected) {
			cached.button.setAttribute("aria-label", chevronLabel(values));
			return cached.button;
		}
		cached?.cleanup();
		const button = document.createElement("button");
		button.type = "button";
		button.tabIndex = -1;
		button.draggable = false;
		button.contentEditable = "false";
		button.className = styles.chevron;
		button.setAttribute("data-table-value-chevron", "");
		button.setAttribute("aria-haspopup", "listbox");
		button.setAttribute("aria-label", chevronLabel(values));
		const glyph = document.createElement("span");
		glyph.className = styles.chevronGlyph;
		glyph.setAttribute("aria-hidden", "true");
		button.append(glyph);
		const onMouseDown = (event: MouseEvent) => {
			// R30 — the press never moves the caret out of the cell and never
			// takes focus; typing stays exactly as today. Stopped before it
			// reaches the editor's own press handling, so no caret jump, no
			// drag start, no margin-click-to-end.
			event.preventDefault();
			event.stopPropagation();
		};
		const onClick = (event: MouseEvent) => {
			event.stopPropagation();
			onChevronToggle();
		};
		const onDragStart = (event: Event) => event.preventDefault();
		button.addEventListener("mousedown", onMouseDown);
		button.addEventListener("click", onClick);
		button.addEventListener("dragstart", onDragStart);
		const cleanup = () => {
			button.removeEventListener("mousedown", onMouseDown);
			button.removeEventListener("click", onClick);
			button.removeEventListener("dragstart", onDragStart);
			cached = null;
		};
		cached = { key, button, cleanup };
		return button;
	};

	return {
		plugin: new Plugin({
			key: inferredSelectPluginKey,
			props: {
				decorations(state: EditorState) {
					const target = pickTargetAtSelection(state);
					if (!target) return DecorationSet.empty;
					const table = state.doc.nodeAt(target.tablePos);
					const cell = state.doc.nodeAt(target.cellPos);
					if (!table || !cell || table.type.name !== "table") {
						return DecorationSet.empty;
					}
					const cellJson = cell.toJSON();
					// R29 — anything but plain text is edited by typing only.
					if (!isPlainTextCell(cellJson)) return DecorationSet.empty;
					const values = inferColumnValues(table.toJSON(), target.columnIndex);
					if (values.length === 0) return DecorationSet.empty;
					const key = `${target.tablePos}:${target.cellPos}`;
					const current = focusedCellValue(cellJson) ?? "";
					const button = buttonFor(key, values);
					button.setAttribute("aria-expanded", "false");
					button.dataset.current = current;
					// Parked at the end of the cell's content: reads as a select
					// arrow after the value, and never disturbs the cell's text.
					const endPos = target.cellPos + cell.nodeSize - 1;
					return DecorationSet.create(state.doc, [
						Decoration.widget(endPos, button, { side: 1 }),
					]);
				},
			},
		}),
		dispose: () => {
			cached?.cleanup();
		},
	};
}

function chevronLabel(values: string[]): string {
	return `Choose a value for this column: ${values.join(", ")}`;
}
