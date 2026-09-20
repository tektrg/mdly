// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceStore } from "../store/state";
import { DocumentNarrowList } from "./DocumentNarrowList";
import { DocumentTable } from "./DocumentTable";
import type { DocumentListingState } from "./documentListingState";
import { setDocumentTableGroupBy } from "./documentTableStore";
import { getNavViewSort, setNavViewSort } from "./navViewSort";
import { buildRows, viewWith } from "./testFixtures";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LISTED: DocumentListingState = { kind: "listed" };
const WORKSPACE = "/ws";

describe("nav sort control", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		workspaceStore.set((state) => ({ ...state, workspacePath: WORKSPACE }));
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		setDocumentTableGroupBy(null);
		workspaceStore.set((state) => ({
			...state,
			workspacePath: null,
			navViewSorts: {},
		}));
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

	function renderTable() {
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
	}

	it("toggles the current view's sort between name and recent, and reflects it", async () => {
		renderTable();
		expect(getNavViewSort(WORKSPACE, "recent")).toEqual({
			column: "modified",
			direction: "desc",
		});
		expect(sortButton()?.getAttribute("aria-pressed")).toBe("false");

		// The store notifies on a microtask, so the pressed state lands after
		// an async flush.
		await act(async () => {
			sortButton()?.click();
		});
		expect(getNavViewSort(WORKSPACE, "recent")).toEqual({
			column: "name",
			direction: "asc",
		});
		expect(sortButton()?.getAttribute("aria-pressed")).toBe("true");

		await act(async () => {
			sortButton()?.click();
		});
		expect(getNavViewSort(WORKSPACE, "recent")).toEqual({
			column: "modified",
			direction: "desc",
		});
		expect(sortButton()?.getAttribute("aria-pressed")).toBe("false");
	});

	it("keeps each view's sort separate and never touches the legacy sidebar sort mode", async () => {
		renderTable();
		await act(async () => {
			setDocumentTableGroupBy("tag");
		});
		await act(async () => {
			sortButton()?.click();
		});
		expect(getNavViewSort(WORKSPACE, "tag")).toEqual({
			column: "name",
			direction: "asc",
		});
		expect(getNavViewSort(WORKSPACE, "folder")).toEqual({
			column: "modified",
			direction: "desc",
		});
		expect(getNavViewSort(WORKSPACE, "recent")).toEqual({
			column: "modified",
			direction: "desc",
		});
		expect(workspaceStore.get().sortMode).toBe("recent");

		// Swapping views re-reads that view's own sort for the button state.
		await act(async () => {
			setDocumentTableGroupBy("folder");
		});
		expect(sortButton()?.getAttribute("aria-pressed")).toBe("false");
		await act(async () => {
			setDocumentTableGroupBy("tag");
		});
		expect(sortButton()?.getAttribute("aria-pressed")).toBe("true");
	});

	it.each([
		[
			{ column: "name", direction: "asc" },
			"Sorted by name — select to sort by recent",
		],
		[
			{ column: "modified", direction: "desc" },
			"Sorted by recent — select to sort by name",
		],
		[
			{ column: "modified", direction: "asc" },
			"Sorted by oldest — select to sort by name",
		],
		[
			{ column: "folder", direction: "asc" },
			"Sorted by folder — select to sort by name",
		],
	] as const)("titles the button accurately for %j", async (sort, title) => {
		setNavViewSort(WORKSPACE, "recent", sort);
		renderTable();
		await act(async () => {});
		expect(sortButton()?.getAttribute("title")).toBe(title);
	});

	it("keeps sorts per workspace: switching away shows the default, switching back restores", async () => {
		renderTable();
		await act(async () => {
			sortButton()?.click();
		});
		expect(sortButton()?.getAttribute("aria-pressed")).toBe("true");

		await act(async () => {
			workspaceStore.set((state) => ({ ...state, workspacePath: "/other" }));
		});
		expect(getNavViewSort("/other", "recent")).toEqual({
			column: "modified",
			direction: "desc",
		});
		expect(sortButton()?.getAttribute("aria-pressed")).toBe("false");

		await act(async () => {
			workspaceStore.set((state) => ({ ...state, workspacePath: WORKSPACE }));
		});
		expect(sortButton()?.getAttribute("aria-pressed")).toBe("true");
		expect(getNavViewSort(WORKSPACE, "recent")).toEqual({
			column: "name",
			direction: "asc",
		});
	});
});
