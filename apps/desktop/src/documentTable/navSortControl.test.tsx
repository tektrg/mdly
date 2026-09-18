// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSortMode } from "../store/actions";
import { workspaceStore } from "../store/state";
import { DocumentNarrowList } from "./DocumentNarrowList";
import { DocumentTable } from "./DocumentTable";
import type { DocumentListingState } from "./documentListingState";
import { buildRows, viewWith } from "./testFixtures";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LISTED: DocumentListingState = { kind: "listed" };

describe("nav sort control", () => {
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
		setSortMode("recent");
	});

	function sortButton(): HTMLButtonElement | null {
		return container.querySelector(
			'[data-nav-list-header] button[aria-label="Sort documents"]',
		);
	}

	it("renders in the full-width table", () => {
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
		expect(sortButton()).not.toBeNull();
	});

	it("renders in the narrow list at every tier, including Rail", () => {
		for (const navTier of ["rail", "list", "card", "table"] as const) {
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
			expect(sortButton()).not.toBeNull();
		}
	});

	it("toggles the workspace sort mode and reflects it", async () => {
		expect(workspaceStore.get().sortMode).toBe("recent");
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

		// The store notifies on a microtask, so the pressed state lands after
		// an async flush.
		await act(async () => {
			sortButton()?.click();
		});
		expect(workspaceStore.get().sortMode).toBe("alpha");
		expect(sortButton()?.getAttribute("aria-pressed")).toBe("true");

		await act(async () => {
			sortButton()?.click();
		});
		expect(workspaceStore.get().sortMode).toBe("recent");
		expect(sortButton()?.getAttribute("aria-pressed")).toBe("false");
	});
});
