// @vitest-environment happy-dom
import type { Editor, JSONContent } from "@tiptap/core";
import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tiptapDocToMarkdown } from "../../engine/index.js";
import { EditorView, type EditorViewProps } from "../../ui/EditorView";

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

	it("O1: draws one dot per column and one per body row, never for the header", () => {
		mount();
		// Anchored inside the table's own scroll box (R36), exactly one overlay.
		const overlays = container.querySelectorAll("[data-table-overlay]");
		expect(overlays).toHaveLength(1);
		expect(overlays[0]?.closest(".tableWrapper")).not.toBeNull();
		expect(colDots()).toHaveLength(3);
		// Two body rows get dots; the header row never does (R1).
		expect(rowDots()).toHaveLength(2);
	});

	it("R7/QA2: a header-only table gets column dots and no row dots", () => {
		mount({ initialMarkdown: `${HEADER_ONLY}\n` });
		expect(colDots()).toHaveLength(2);
		expect(rowDots()).toHaveLength(0);
	});

	it("R33/O14: without the opt-in prop nothing mounts and nothing measures", () => {
		mount({ tableInteractivity: undefined });
		expect(container.querySelector("[data-table-overlay]")).toBeNull();
		expect(colDots()).toHaveLength(0);
		expect(rowDots()).toHaveLength(0);
	});

	it("R45: a read-only surface offers no dots", () => {
		mount({ editable: false });
		expect(colDots()).toHaveLength(0);
		expect(rowDots()).toHaveLength(0);
	});

	it("R1: dots show on hover and clear when the pointer leaves", () => {
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
		act(() => {
			wrapper.dispatchEvent(new Event("pointerleave"));
		});
		expect(overlay.getAttribute("data-hovered")).toBe("false");
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

	it("O4: click a dot, Delete removes the column, one undo restores it", async () => {
		const { live } = mount();
		const before = markdownOf(live);
		const dot = colDots()[0];
		if (!dot) throw new Error("Expected a column dot");

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
