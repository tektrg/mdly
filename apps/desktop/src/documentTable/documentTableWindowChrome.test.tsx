// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentNarrowList } from "./DocumentNarrowList";
import { DocumentTable } from "./DocumentTable";
import type { DocumentListingState } from "./documentListingState";
import { buildRows, viewWith } from "./testFixtures";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LISTED: DocumentListingState = { kind: "listed" };

/**
 * B2 — the window-drag strip (`.desktop-window-drag-strip`, fixed, z-10,
 * `-webkit-app-region: drag`) and the two floating pills that live inside it
 * (note-actions at the inline end, show-sidebar at the inline start) own the
 * top band of the window. `Toolbar` renders only fixed content, so the first
 * in-flow child of `<main>` starts at y=0 — i.e. underneath all three.
 *
 * Both document-table headers must reserve that band rather than fight it on
 * z-index: the drag strip swallows pointer events for anything painted below
 * it, so a filter box inside the band is both covered by the pill and, per
 * Chromium's paint-order resolution of `-webkit-app-region`, not reliably
 * clickable at all.
 */
function dragStripBlockSize(): string {
	// `import.meta.dirname`, not `new URL(...)`: happy-dom replaces the global
	// `URL`, and `fileURLToPath` then rejects it.
	const css = readFileSync(join(import.meta.dirname, "..", "index.css"), {
		encoding: "utf8",
	});
	const rule = css.match(
		/\.desktop-window-drag-strip\s*\{[^}]*block-size:\s*([^;]+);/,
	);
	if (!rule?.[1]) throw new Error("drag strip block-size not found");
	return rule[1].trim();
}

describe("document table window chrome (B2)", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function headerClassName(): string {
		return container.querySelector<HTMLElement>("header")?.className ?? "";
	}

	it("reserves at least the drag strip's own height, so the two cannot drift", () => {
		// The floor is the strip height itself; if `index.css` ever changes it,
		// this test fails instead of the header silently sliding back under it.
		expect(dragStripBlockSize()).toBe("2.75rem");
	});

	it("starts the full table's header content below the drag strip", () => {
		act(() => {
			root.render(
				<DocumentTable
					rows={buildRows()}
					view={viewWith()}
					listing={LISTED}
					onOpenDocument={vi.fn()}
					onFilterChange={vi.fn()}
					onToggleSort={vi.fn()}
					onRetryListing={vi.fn()}
				/>,
			);
		});

		expect(headerClassName()).toContain(
			"[padding-block-start:max(2.75rem,calc(var(--hubble-traffic-light-top-inset,0px)+0.375rem))]",
		);
		// A physical `pt-*` on the same element would silently win or lose
		// depending on class order, and violates the repo's logical-props rule.
		expect(headerClassName()).not.toMatch(/\bpt-\d/);
		expect(headerClassName()).not.toMatch(/\bpy-\d/);
	});

	it("starts the narrow list's header content below the drag strip", () => {
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
				/>,
			);
		});

		expect(headerClassName()).toContain(
			"[padding-block-start:max(2.75rem,calc(var(--hubble-traffic-light-top-inset,0px)+0.375rem))]",
		);
		expect(headerClassName()).not.toMatch(/\bpt-\d/);
		expect(headerClassName()).not.toMatch(/\bpy-\d/);
	});
});
