// @vitest-environment happy-dom
import type { Editor } from "@tiptap/core";
import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TABLE_OVERLAY_MOUNT_ATTR } from "../../engine/Table.js";
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

/**
 * Regression: slice 1 portals its dot overlay into ProseMirror-managed DOM,
 * which the observer repairs away within a frame. The table NodeView owns an
 * empty `contenteditable="false"` mount inside the `.tableWrapper` scroll box
 * and ignores observer mutations outside its `<tbody>` content root, so the
 * portal survives flushes, edits, and in-place node re-renders.
 */
describe("TableInteractionLayer overlay survival", () => {
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

	function mount(overrides: Partial<EditorViewProps> = {}): Editor {
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
		act(() => root.render(<EditorView {...props} />));
		if (!editor) throw new Error("editor never ready");
		return editor as Editor;
	}

	function dots() {
		return container.querySelectorAll("[data-table-col-handle]").length;
	}

	function overlays() {
		return container.querySelectorAll("[data-table-overlay]").length;
	}

	function wrappers() {
		return container.querySelectorAll(".tableWrapper").length;
	}

	function hoverTable() {
		const table = container.querySelector("table");
		if (!table) throw new Error("no table rendered");
		act(() => {
			table.dispatchEvent(
				new Event("pointerenter", { bubbles: true, cancelable: true }),
			);
			table.dispatchEvent(
				new Event("pointerover", { bubbles: true, cancelable: true }),
			);
			table.dispatchEvent(
				new Event("mouseenter", { bubbles: true, cancelable: true }),
			);
		});
	}

	async function settle(frames: number) {
		for (let i = 0; i < frames; i += 1) {
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 20));
			});
		}
	}

	/** First text position inside the table's first cell. */
	function firstCellTextPos(live: Editor): number {
		let found = -1;
		live.state.doc.descendants((node, pos) => {
			if (found >= 0) return false;
			if (node.type.name === "tableCell" || node.type.name === "tableHeader") {
				found = pos + 2;
				return false;
			}
			return true;
		});
		if (found < 0) throw new Error("no table cell found");
		return found;
	}

	it("dots and overlay survive observer flushes and a document edit", async () => {
		const live = mount();
		hoverTable();
		expect({
			dots: dots(),
			overlays: overlays(),
			wrappers: wrappers(),
		}).toEqual({ dots: 3, overlays: 1, wrappers: 1 });
		await settle(6);
		expect({
			dots: dots(),
			overlays: overlays(),
			wrappers: wrappers(),
		}).toEqual({ dots: 3, overlays: 1, wrappers: 1 });

		// The overlay anchors inside the table's own scroll box (R36) via the
		// NodeView-owned mount, which ProseMirror agrees to leave alone.
		const overlay = container.querySelector("[data-table-overlay]");
		const mountEl = container.querySelector(`[${TABLE_OVERLAY_MOUNT_ATTR}]`);
		if (!overlay || !(mountEl instanceof HTMLElement)) {
			throw new Error("expected the overlay inside its NodeView mount");
		}
		expect(mountEl.getAttribute("contenteditable")).toBe("false");
		expect(mountEl.contains(overlay)).toBe(true);
		expect(mountEl.closest(".tableWrapper")).not.toBeNull();

		// A real document edit must not take the overlay with it.
		act(() => {
			(live as Editor)
				.chain()
				.focus()
				.setTextSelection(firstCellTextPos(live))
				.insertContent("x")
				.run();
		});
		await settle(5);
		expect({
			dots: dots(),
			overlays: overlays(),
			wrappers: wrappers(),
		}).toEqual({ dots: 3, overlays: 1, wrappers: 1 });
	});

	it("survives a ProseMirror re-render of the table node in place", async () => {
		const live = mount();
		hoverTable();
		const wrapperBefore = container.querySelector(".tableWrapper");
		if (!wrapperBefore) throw new Error("no table wrapper rendered");
		await settle(2);

		// Typing inside a cell re-renders the table node: the NodeView's
		// `update` must keep the same wrapper (no teardown), so the portal
		// never remounts and the dots stay correct.
		act(() => {
			(live as Editor)
				.chain()
				.focus()
				.setTextSelection(firstCellTextPos(live))
				.insertContent("yz")
				.run();
		});
		await settle(5);
		expect(container.querySelector(".tableWrapper")).toBe(wrapperBefore);
		expect({
			dots: dots(),
			overlays: overlays(),
			wrappers: wrappers(),
		}).toEqual({ dots: 3, overlays: 1, wrappers: 1 });
		// Re-hovering after the re-render still finds the same overlay.
		hoverTable();
		await settle(1);
		expect({
			dots: dots(),
			overlays: overlays(),
			wrappers: wrappers(),
		}).toEqual({ dots: 3, overlays: 1, wrappers: 1 });
	});

	it("dots recount after a table-shape edit without losing the overlay", async () => {
		mount();
		hoverTable();
		await settle(2);
		const dot = container.querySelector<HTMLButtonElement>(
			"[data-table-col-handle]",
		);
		if (!dot) throw new Error("expected a column dot");
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
		if (!deleteButton) throw new Error("expected the Delete menu to open");
		act(() => {
			deleteButton.dispatchEvent(new Event("click", { bubbles: true }));
		});
		await settle(5);
		// One column gone, overlay intact, dots recount to the new shape.
		expect({
			dots: dots(),
			overlays: overlays(),
			wrappers: wrappers(),
		}).toEqual({ dots: 2, overlays: 1, wrappers: 1 });
	});
});
