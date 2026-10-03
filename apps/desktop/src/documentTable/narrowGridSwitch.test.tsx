// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DocumentNarrowList,
	NARROW_GRID_BREAKPOINT,
} from "./DocumentNarrowList";
import type { DocumentListingState } from "./documentListingState";
import type { NavDensityTier } from "./navDensity";
import { buildRows, viewWith } from "./testFixtures";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LISTED: DocumentListingState = { kind: "listed" };

/** happy-dom has no layout: a fake observer lets the test drive the width. */
const observers: { callback: ResizeObserverCallback; target?: Element }[] = [];
class FakeResizeObserver {
	private entry: { callback: ResizeObserverCallback; target?: Element };
	constructor(callback: ResizeObserverCallback) {
		this.entry = { callback };
		observers.push(this.entry);
	}
	observe(target: Element) {
		this.entry.target = target;
	}
	disconnect() {}
	unobserve() {}
}

function resizeList(width: number) {
	const list = document.querySelector("[data-nav-tier]");
	act(() => {
		for (const { callback, target } of observers) {
			if (target !== list) continue;
			callback(
				[{ contentRect: { width } } as ResizeObserverEntry],
				{} as ResizeObserver,
			);
		}
	});
}

describe("DocumentNarrowList stacked -> grid switch", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		observers.length = 0;
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	function render(navTier: NavDensityTier) {
		act(() => {
			root.render(
				<DocumentNarrowList
					rows={buildRows()}
					view={viewWith()}
					listing={LISTED}
					onOpenDocument={vi.fn()}
					onFilterChange={vi.fn()}
					onShowAllDocuments={vi.fn()}
					onRetryListing={vi.fn()}
					navTier={navTier}
				/>,
			);
		});
	}

	const list = () => container.querySelector<HTMLElement>("[data-nav-tier]");
	const firstRow = () =>
		container.querySelector<HTMLElement>("[data-document-row-index]");

	it("switches to one-line grid cells at the breakpoint, keeping row height", () => {
		render("table");
		expect(list()?.dataset.rowLayout).toBe("stacked");
		const stackedHeight = firstRow()?.style.blockSize;
		expect(container.querySelector('[role="columnheader"]')).toBeNull();

		resizeList(NARROW_GRID_BREAKPOINT - 1);
		expect(list()?.dataset.rowLayout).toBe("stacked");

		resizeList(NARROW_GRID_BREAKPOINT);
		expect(list()?.dataset.rowLayout).toBe("grid");
		expect(
			container.querySelectorAll('[role="columnheader"]').length,
		).toBeGreaterThan(1);
		expect(firstRow()?.style.blockSize).toBe(stackedHeight);
		// Every cell carries a stable id shared with the stacked layout.
		const ids = Array.from(
			firstRow()?.querySelectorAll<HTMLElement>("[data-flip-id]") ?? [],
			(node) => node.dataset.flipId,
		);
		expect(ids).toContain("/ws/alpha.md::name");
		expect(ids).toContain("/ws/alpha.md::modified");

		resizeList(NARROW_GRID_BREAKPOINT - 100);
		expect(list()?.dataset.rowLayout).toBe("stacked");
		expect(container.querySelector('[role="columnheader"]')).toBeNull();
	});

	it("never shows the grid on Rail, which hides the secondary info", () => {
		render("rail");
		resizeList(NARROW_GRID_BREAKPOINT + 50);
		expect(list()?.dataset.rowLayout).toBe("stacked");
	});

	it("widens the name -> secondary gap via a CSS var as the list nears the switch", () => {
		render("list");
		resizeList(NARROW_GRID_BREAKPOINT - 200);
		expect(list()?.style.getPropertyValue("--sidebar-compact-meta-gap")).toBe(
			"0px",
		);
		resizeList(NARROW_GRID_BREAKPOINT - 40);
		expect(list()?.style.getPropertyValue("--sidebar-compact-meta-gap")).toBe(
			"14.4px",
		);
	});
});
