import type { Editor } from "@tiptap/react";
import type { RefObject } from "react";

/**
 * Frozen contract between the three table-interactivity slices so they can be
 * built independently. Slice 1 owns `TableInteractionLayer`, slice 2 owns
 * `TableWidthControl`, slice 3 owns `TableValuePicker`; none of them edits
 * `EditorView.tsx` or each other's files.
 */

/** One GFM table currently on the page. */
export type TableTarget = {
	/** Session-only per-table id minted at parse time (charter R24). */
	uid: string;
	/** Document position of the `table` node. */
	pos: number;
	/** The rendered `<table>` element. */
	tableEl: HTMLTableElement;
	/**
	 * The `.tableWrapper` scroll box that owns the table. Overlays anchor here,
	 * never at viewport level, so dots track the page by CSS instead of scroll
	 * listeners (charter R36).
	 */
	wrapperEl: HTMLElement;
};

/** Slice 1 — mounted by `EditorView` only when table interactivity is opted in. */
export type TableInteractionLayerProps = {
	editor: Editor | null;
	viewportRef: RefObject<HTMLElement | null>;
	/**
	 * `false` on a read-only surface: no dots and no delete menu, but the
	 * session-only expand control still works (charter R45).
	 */
	editable: boolean;
};

/** Slice 2 — rendered per table by the slice 1 layer. */
export type TableWidthControlProps = {
	editor: Editor;
	target: TableTarget;
	/** True while the pointer is inside this table; the layer owns hover state. */
	hovered: boolean;
};

/** Slice 3 — mounted by `EditorView`, independent of the slice 1 layer. */
export type TableValuePickerProps = {
	editor: Editor | null;
	viewportRef: RefObject<HTMLElement | null>;
};
