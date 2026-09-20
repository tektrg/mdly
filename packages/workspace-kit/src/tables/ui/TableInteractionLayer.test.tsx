// @vitest-environment happy-dom
import type { Editor, JSONContent } from "@tiptap/core";
import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tiptapDocToMarkdown } from "../../engine/index.js";
import { EditorView, type EditorViewProps } from "../../ui/EditorView";
import styles from "./TableInteractionLayer.module.css";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const THREE_BY_TWO = [
	"| A | B | C |",
	"| --- | --- | --- |",
	"| 1 | 2 | 3 |",
	"| 4 | 5 | 6 |",
].join("\n");

const HEADER_ONLY = ["| A | B |", "| --- | --- |"].join("\n");

describe("TableInteractionLayer (slice 1)", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let editor: Editor | null = null;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		editor = null;
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function mount(overrides: Partial<EditorViewProps> = {}) {
		const props: EditorViewProps = {
			path: "/workspace/table.md",
			initialMarkdown: `${THREE_BY_TWO}\n`,
			saveDebounceMs: 0,
			onLocalChange: vi.fn(),
			onSave: vi.fn(),
			onOpenExternalLink: vi.fn(),
			onOpenWikiLink: vi.fn(),
			onEditorReady: (ready: Editor | null) => {
				editor = ready;
			},
			tableInteractivity: true,
			...overrides,
		};
		act(() => {
			root.render(<EditorView {...props} />);
		});
		if (!editor) throw new Error("Editor was never ready");
		return { props, live: editor as Editor };
	}

	function colDots(): HTMLButtonElement[] {
		return Array.from(
			container.querySelectorAll<HTMLButtonElement>("[data-table-col-handle]"),
		);
	}

	function rowDots(): HTMLButtonElement[] {
		return Array.from(
			container.querySelectorAll<HTMLButtonElement>("[data-table-row-handle]"),
		);
	}

	function markdownOf(live: Editor): string {
		return tiptapDocToMarkdown(live.getJSON());
	}

	/** The cell at (row, column) of the rendered table, header row included. */
	function cellAt(rowIndex: number, cellIndex: number): Element {
		const row = container.querySelectorAll("tr")[rowIndex];
		const cell = row?.children[cellIndex];
		if (!cell)
			throw new Error(`no cell at row ${rowIndex}, column ${cellIndex}`);
		return cell;
	}

	/**
	 * Move the pointer into a cell. The layer observes `pointermove` on the
	 * table's wrapper (the only element that can see a real pointer entering
	 * the table), so the event is dispatched on the cell and bubbles.
	 */
	function hoverCell(cell: Element): void {
		act(() => {
			// A real pointer enters the table's wrapper before it lands in a cell.
			cell.closest(".tableWrapper")?.dispatchEvent(new Event("pointerenter"));
			cell.dispatchEvent(new Event("pointermove", { bubbles: true }));
		});
	}

	function colIndexes(): (string | undefined)[] {
		return colDots().map((dot) => dot.dataset.col);
	}

	function rowIndexes(): (string | undefined)[] {
		return rowDots().map((dot) => dot.dataset.row);
	}

	it("O1: draws one handle per axis, only for the cell under the pointer", () => {
		mount();
		// Anchored inside the table's own scroll box (R36), exactly one overlay.
		const overlays = container.querySelectorAll("[data-table-overlay]");
		expect(overlays).toHaveLength(1);
		expect(overlays[0]?.closest(".tableWrapper")).not.toBeNull();
		// Hovering the table but no cell yet draws nothing.
		const wrapper = overlays[0]?.closest(".tableWrapper") ?? null;
		expect(wrapper).not.toBeNull();
		act(() => {
			wrapper?.dispatchEvent(new Event("pointerenter"));
		});
		expect(colDots()).toHaveLength(0);
		expect(rowDots()).toHaveLength(0);

		// The last body row, middle column: exactly those two handles, and no
		// others (the header is body row 0's predecessor, never a slot).
		hoverCell(cellAt(2, 1));
		expect(colIndexes()).toEqual(["1"]);
		expect(rowIndexes()).toEqual(["1"]);

		// Moving to another cell moves and relabels the same two handles.
		hoverCell(cellAt(1, 2));
		expect(colIndexes()).toEqual(["2"]);
		expect(rowIndexes()).toEqual(["0"]);

		// A header cell carries the column handle only — the header can never
		// be a row-drop target (R3).
		hoverCell(cellAt(0, 0));
		expect(colIndexes()).toEqual(["0"]);
		expect(rowDots()).toHaveLength(0);

		// Moving onto the handle itself (a real mouse does, on the way to a
		// drag) must not clear the handle it just revealed.
		const handle = colDots()[0];
		act(() => {
			handle?.dispatchEvent(new Event("pointermove", { bubbles: true }));
		});
		expect(colIndexes()).toEqual(["0"]);
	});

	it("R36: grows the wrapper's own box so both handles sit outside the table", () => {
		mount();
		const wrapper = container.querySelector(".tableWrapper") as HTMLElement;
		if (!wrapper) throw new Error("expected the table wrapper");
		// `.chrome` buys the band above the table (column grip) and the gutter
		// to its inline-start (row grip) as the wrapper's own padding, and hands
		// the padding straight back as negative margin — so the table's flow
		// position, and every other block's, is untouched. The wrapper's own
		// block-start margin is per-neighbour, so the layer hands it in.
		expect(wrapper.classList.contains(styles.chrome)).toBe(true);
		expect(
			wrapper.style.getPropertyValue("--table-flow-margin-block-start"),
		).not.toBe("");
		// …and it must be recognisable to the editor's own stylesheet, whose
		// `max-inline-size: 100%` cap on table wrappers would otherwise clamp
		// that band, the gutter and the full-width rule back to the column
		// width. `EditorView.css` matches this attribute by name.
		expect(wrapper.getAttribute("data-table-chrome")).toBe("true");
	});

	it("R7/QA2: a header-only table gets a column handle and no row handle", () => {
		mount({ initialMarkdown: `${HEADER_ONLY}\n` });
		hoverCell(cellAt(0, 1));
		expect(colIndexes()).toEqual(["1"]);
		expect(rowDots()).toHaveLength(0);
	});

	it("R33/O14: without the opt-in prop nothing mounts and nothing measures", () => {
		mount({ tableInteractivity: undefined });
		expect(container.querySelector("[data-table-overlay]")).toBeNull();
		expect(colDots()).toHaveLength(0);
		expect(rowDots()).toHaveLength(0);
	});

	it("R45: a read-only surface offers no handles", () => {
		mount({ editable: false });
		hoverCell(cellAt(1, 0));
		expect(colDots()).toHaveLength(0);
		expect(rowDots()).toHaveLength(0);
	});

	it("R1: handles outlive a pointer that leaves, then clear", async () => {
		mount();
		const overlay = container.querySelector("[data-table-overlay]");
		if (!overlay) throw new Error("Expected the table overlay to mount");
		// Real hover is detected on the wrapper, not the overlay itself: the
		// overlay is `pointer-events: none` and a DOM sibling of the table (not
		// an ancestor), so a genuine pointer entering the table can only ever
		// be observed by the wrapper that contains both.
		const wrapper = overlay.closest(".tableWrapper");
		if (!wrapper) throw new Error("Expected the table wrapper");
		expect(overlay.getAttribute("data-hovered")).toBe("false");
		act(() => {
			wrapper.dispatchEvent(new Event("pointerenter"));
		});
		expect(overlay.getAttribute("data-hovered")).toBe("true");
		hoverCell(cellAt(1, 0));
		expect(colDots()).toHaveLength(1);
		expect(rowDots()).toHaveLength(1);
		act(() => {
			wrapper.dispatchEvent(new Event("pointerleave"));
		});
		// Grace period: both handles sit outside the table's own box, so the
		// pointer crosses the wrapper's edge on its way to click one. The
		// chrome must still be there when it arrives.
		expect(overlay.getAttribute("data-hovered")).toBe("true");
		expect(colDots()).toHaveLength(1);
		expect(rowDots()).toHaveLength(1);
		// Returning inside before the timer fires keeps it up for good.
		act(() => {
			wrapper.dispatchEvent(new Event("pointerenter"));
		});
		await act(async () => {
			await new Promise((resolve) => window.setTimeout(resolve, 1200));
		});
		expect(overlay.getAttribute("data-hovered")).toBe("true");
		expect(colDots()).toHaveLength(1);
		// Left for good: the delay elapses and the chrome goes away.
		act(() => {
			wrapper.dispatchEvent(new Event("pointerleave"));
		});
		await act(async () => {
			await new Promise((resolve) => window.setTimeout(resolve, 1200));
		});
		expect(overlay.getAttribute("data-hovered")).toBe("false");
		expect(colDots()).toHaveLength(0);
		expect(rowDots()).toHaveLength(0);
	});

	it("R1: leaving the editor pane is delayed too", async () => {
		mount();
		const wrapper = container.querySelector(".tableWrapper");
		const viewport = container.querySelector(".editorViewport");
		if (!wrapper || !viewport)
			throw new Error("Expected the wrapper and the editor viewport");
		act(() => {
			wrapper.dispatchEvent(new Event("pointerenter"));
		});
		hoverCell(cellAt(1, 1));
		expect(colDots()).toHaveLength(1);
		// Out of the pane entirely -- the pointer keeps its grace period, so the
		// chrome does not blink out on the way to a control beside the table.
		act(() => {
			viewport.dispatchEvent(new Event("pointerleave"));
		});
		expect(colDots()).toHaveLength(1);
		expect(rowDots()).toHaveLength(1);
		await act(async () => {
			await new Promise((resolve) => window.setTimeout(resolve, 1200));
		});
		expect(colDots()).toHaveLength(0);
		expect(rowDots()).toHaveLength(0);
	});

	it("R8/O6: hovering writes nothing", () => {
		const { live } = mount();
		const before = markdownOf(live);
		const overlay = container.querySelector("[data-table-overlay]");
		if (!overlay) throw new Error("Expected the table overlay to mount");
		const wrapper = overlay.closest(".tableWrapper");
		if (!wrapper) throw new Error("Expected the table wrapper");
		act(() => {
			wrapper.dispatchEvent(new Event("pointerenter"));
			wrapper.dispatchEvent(new Event("pointerleave"));
		});
		expect(markdownOf(live)).toBe(before);
	});

	it("O4: click a handle, Delete removes the column, one undo restores it", async () => {
		const { live } = mount();
		const before = markdownOf(live);
		// The handle only exists for the column the pointer is in.
		hoverCell(cellAt(1, 0));
		const dot = colDots()[0];
		if (!dot) throw new Error("Expected a column handle");

		// Press and release without moving: a click, not a drag.
		act(() => {
			dot.dispatchEvent(
				Object.assign(new Event("pointerdown", { bubbles: true }), {
					button: 0,
					pointerId: 7,
					clientX: 100,
					clientY: 50,
				}),
			);
		});
		act(() => {
			window.dispatchEvent(
				Object.assign(new Event("pointerup", { bubbles: true }), {
					pointerId: 7,
					clientX: 101,
					clientY: 51,
				}),
			);
		});

		const deleteButton = container.querySelector<HTMLButtonElement>(
			"[data-table-delete]",
		);
		if (!deleteButton) throw new Error("Expected the Delete menu to open");
		// The menu's only item is Delete (R4).
		expect(deleteButton.textContent).toBe("Delete");

		act(() => {
			deleteButton.dispatchEvent(new Event("click", { bubbles: true }));
		});
		await act(async () => {
			await new Promise((resolve) => window.setTimeout(resolve, 50));
		});

		const afterDelete = markdownOf(live);
		expect(afterDelete).not.toContain("| A |");
		expect(afterDelete).toContain("| B | C |");
		// The menu closed itself on commit.
		expect(container.querySelector("[data-table-delete]")).toBeNull();

		act(() => {
			live.commands.undo();
		});
		// Trailing-newline-insensitive: the mounted editor keeps a cosmetic
		// trailing paragraph that the serializer may render as blank lines.
		expect(markdownOf(live).trim()).toBe(before.trim());
	});

	it("QC8: a table nested in another table's cell never mis-targets the outer table's overlay", async () => {
		const { live } = mount();

		// Nest a second table inside the outer table's first cell (same shape
		// as tableTransforms.test.ts's QC4 fixture).
		const json = live.getJSON() as JSONContent;
		const firstCell = json.content?.[0]?.content?.[0]?.content?.[0];
		if (!firstCell) throw new Error("No first cell to nest into");
		firstCell.content = [
			{
				type: "table",
				attrs: { uid: "nested-test-table" },
				content: [
					{
						type: "tableRow",
						content: [
							{
								type: "tableHeader",
								attrs: { align: null },
								content: [
									{
										type: "paragraph",
										content: [{ type: "text", text: "N" }],
									},
								],
							},
						],
					},
				],
			},
		];
		act(() => {
			live.commands.setContent(json);
		});
		// The rescan that discovers the freshly-nested table is rAF-coalesced
		// (R34/R37), so it does not land within this act() call -- give it a
		// real frame before asserting, same pattern as the overlay-survival
		// probe that caught the ProseMirror DOM-repair bug.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
		});

		// R16: the inner table is never a handle target, so exactly one overlay
		// exists -- for the outer table.
		const overlays = container.querySelectorAll<HTMLElement>(
			"[data-table-overlay]",
		);
		expect(overlays).toHaveLength(1);
		// Regression guard for QC8: before the fix, `overlayMountFor` did a
		// full descendant `querySelector` from the outer wrapper, which found
		// the INNER table's mount first (encountered earlier in document
		// order, buried inside a `<td>`) instead of the outer wrapper's own
		// direct-child mount. A portal landing inside a `<td>`/`<th>` is the
		// unambiguous, direct signature of that bug.
		expect(overlays[0]?.closest("td, th")).toBeNull();
		// And it does land inside the outer table's own wrapper.
		expect(overlays[0]?.closest(".tableWrapper")).not.toBeNull();
	});
});
