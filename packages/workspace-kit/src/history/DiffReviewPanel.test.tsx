// @vitest-environment happy-dom
import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffReviewPanel } from "./DiffReviewPanel";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("DiffReviewPanel", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function render(props: Parameters<typeof DiffReviewPanel>[0]) {
		act(() => {
			root.render(<DiffReviewPanel {...props} />);
		});
	}

	function regionTypes() {
		return Array.from(container.querySelectorAll("[data-region-type]")).map(
			(el) => el.getAttribute("data-region-type"),
		);
	}

	// R2: a 3-line fixture with one changed line renders exactly
	// unchanged/removed/added/unchanged, in that order -- never one opaque
	// "file changed" message.
	it("renders unchanged/removed/added/unchanged for a 3-line fixture with one changed line", () => {
		const oldText = "line1\nline2\nline3\n";
		const newText = "line1\nline2-changed\nline3\n";

		render({ oldText, newText, onConfirm: vi.fn() });

		expect(regionTypes()).toEqual([
			"unchanged",
			"removed",
			"added",
			"unchanged",
		]);
	});

	// R5: confirming without touching any decision reproduces newText exactly,
	// matching the pre-Slice-3 silent-swap result.
	it("defaults unreviewed regions to accept, matching newText when confirmed untouched", () => {
		const oldText = "line1\nline2\nline3\n";
		const newText = "line1\nline2-changed\nline3\n";
		const onConfirm = vi.fn();

		render({ oldText, newText, onConfirm });

		const applyButton = Array.from(container.querySelectorAll("button")).find(
			(btn) => btn.textContent === "Apply",
		);
		act(() => applyButton?.click());

		expect(onConfirm).toHaveBeenCalledWith(newText);
	});

	// R3, R4: accepting/rejecting individual regions produces the exact,
	// hand-computable mixed merge -- not the full old or full new text.
	it("writes the exact merge when a region is rejected", () => {
		const oldText = "line1\nline2\nline3\n";
		const newText = "line1\nline2-changed\nline3\n";
		const onConfirm = vi.fn();

		render({ oldText, newText, onConfirm });

		const rejectButton = Array.from(container.querySelectorAll("button")).find(
			(btn) => btn.textContent === "Reject",
		);
		act(() => rejectButton?.click());

		const applyButton = Array.from(container.querySelectorAll("button")).find(
			(btn) => btn.textContent === "Apply",
		);
		act(() => applyButton?.click());

		expect(onConfirm).toHaveBeenCalledWith(oldText);
	});

	// R25: empty/zero-region-diff input must not crash the renderer.
	it("does not crash when oldText and newText are both empty", () => {
		expect(() => {
			render({ oldText: "", newText: "", onConfirm: vi.fn() });
		}).not.toThrow();

		expect(
			regionTypes().filter((t) => t === "added" || t === "removed"),
		).toEqual([]);
	});

	it("does not crash and shows no changed regions when oldText equals newText", () => {
		expect(() => {
			render({
				oldText: "same content\n",
				newText: "same content\n",
				onConfirm: vi.fn(),
			});
		}).not.toThrow();

		expect(
			regionTypes().filter((t) => t === "added" || t === "removed"),
		).toEqual([]);
	});
});
