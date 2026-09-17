// @vitest-environment happy-dom
import type { Editor } from "@tiptap/react";
import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TableWidthControl } from "./TableWidthControl.js";
import styles from "./TableWidthControl.module.css";
import { setTableExpanded } from "./tableFullWidth.js";
import type { TableTarget } from "./tableInteractionTypes.js";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("TableWidthControl (slice 2, R19–R25)", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let viewport: HTMLDivElement;
	let wrapperEl: HTMLDivElement;
	let tableEl: HTMLTableElement;
	let emit: ReturnType<typeof vi.fn>;
	let dispatch: ReturnType<typeof vi.fn>;
	let editor: Editor;

	function makeTarget(uid: string): TableTarget {
		return { uid, pos: 0, tableEl, wrapperEl };
	}

	beforeEach(() => {
		for (const uid of ["tbl-a", "tbl-b"]) setTableExpanded(uid, false);
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		viewport = document.createElement("div");
		viewport.className = "editorViewport";
		wrapperEl = document.createElement("div");
		wrapperEl.className = "tableWrapper";
		tableEl = document.createElement("table");
		wrapperEl.append(tableEl);
		viewport.append(wrapperEl);
		container.append(viewport);
		emit = vi.fn();
		dispatch = vi.fn();
		editor = {
			emit,
			on() {},
			off() {},
			view: { dispatch },
		} as unknown as Editor;
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function renderControl(uid = "tbl-a", hovered = true) {
		act(() => {
			root.render(
				<TableWidthControl
					editor={editor}
					target={makeTarget(uid)}
					hovered={hovered}
				/>,
			);
		});
		return container.querySelector("button") as HTMLButtonElement;
	}

	it("stays hidden until hovered, and unfocusable while hidden", () => {
		renderControl("tbl-a", false);
		const control = container.querySelector(`.${styles.control}`);
		expect(control?.getAttribute("data-visible")).toBe("false");
		const button = container.querySelector("button") as HTMLButtonElement;
		expect(button.tabIndex).toBe(-1);
	});

	it("shows an Expand button on hover that toggles the wrapper class and reads as Collapse", () => {
		const button = renderControl("tbl-a", true);
		expect(button.textContent).toBe("Expand");
		expect(button.getAttribute("aria-expanded")).toBe("false");
		act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(wrapperEl.classList.contains(styles.fullWidth)).toBe(true);
		expect(wrapperEl.getAttribute("data-table-full-width")).toBe("true");
		expect(button.textContent).toBe("Collapse");
		expect(button.getAttribute("aria-expanded")).toBe("true");
		act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(wrapperEl.classList.contains(styles.fullWidth)).toBe(false);
		expect(wrapperEl.hasAttribute("data-table-full-width")).toBe(false);
		expect(button.textContent).toBe("Expand");
	});

	it("stays visible while expanded even after the pointer leaves (R19)", () => {
		const button = renderControl("tbl-a", true);
		act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		renderControl("tbl-a", false);
		const control = container.querySelector(`.${styles.control}`);
		expect(control?.getAttribute("data-visible")).toBe("true");
		expect(button.textContent).toBe("Collapse");
	});

	it("writes nothing: toggling never dispatches a transaction (R23)", () => {
		const button = renderControl("tbl-a", true);
		act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("nudges the overlays exactly once per toggle (R25)", () => {
		const button = renderControl("tbl-a", true);
		act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(emit).toHaveBeenCalledTimes(1);
	});

	it("is per table: expanding one uid leaves a sibling uid collapsed (R23)", () => {
		renderControl("tbl-a", true);
		const button = container.querySelector("button") as HTMLButtonElement;
		act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(wrapperEl.classList.contains(styles.fullWidth)).toBe(true);
		// Same component instance retargeted at a different table (a rescan):
		// the sibling starts collapsed.
		renderControl("tbl-b", true);
		expect(wrapperEl.classList.contains(styles.fullWidth)).toBe(false);
	});

	it("establishes the pane as a query container and cleans up on unmount", () => {
		renderControl("tbl-a", true);
		expect(viewport.style.getPropertyValue("container-type")).toBe(
			"inline-size",
		);
		act(() => {
			root.render(
				<TableWidthControl
					editor={editor}
					target={makeTarget("tbl-a")}
					hovered={true}
				/>,
			);
		});
		// Expanded, then unmounted: the wrapper class is removed with it.
		const button = container.querySelector("button") as HTMLButtonElement;
		act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(wrapperEl.classList.contains(styles.fullWidth)).toBe(true);
		act(() => root.unmount());
		expect(wrapperEl.classList.contains(styles.fullWidth)).toBe(false);
		expect(wrapperEl.classList.contains(styles.anchored)).toBe(false);
		expect(viewport.style.getPropertyValue("container-type")).toBe("");
		// Re-create the root for the shared afterEach unmount.
		root = createRoot(container);
	});
});
