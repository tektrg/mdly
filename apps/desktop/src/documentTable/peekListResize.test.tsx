// @vitest-environment happy-dom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NAV_RAIL_MIN_WIDTH, PEEK_DOCUMENT_MIN_WIDTH } from "../lib/navLayout";
import { getInitialState, serialize } from "../store/persistence";
import type { FileEntry } from "../store/state";
import { appStore, workspaceStore } from "../store/state";
import { STORAGE_KEY } from "../store/storage";
import { DocumentNarrowList } from "./DocumentNarrowList";
import {
	DOCUMENT_CARD_ROW_HEIGHT,
	DOCUMENT_LIST_ROW_HEIGHT,
	DOCUMENT_NARROW_TABLE_ROW_HEIGHT,
	documentRowHeight,
	formatModifiedAt,
} from "./DocumentRowList";
import type { DocumentListingState } from "./documentListingState";
import { clampPeekListWidth, columnsForTier, densityTier } from "./navDensity";
import { listWidthFromPointer, PeekListDivider } from "./PeekListDivider";
import {
	getPeekListDesiredWidth,
	PEEK_LIST_DEFAULT_WIDTH,
	setPeekListDesiredWidth,
} from "./peekListWidth";
import { buildRows, viewWith } from "./testFixtures";
import { useNavContainerWidth } from "./useNavContainerWidth";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LISTED: DocumentListingState = { kind: "listed" };
const REMOUNT_WORKSPACE = "/ws-peek-resize-remount";

describe("peek width to tier to columns pipeline (R9)", () => {
	it("walks one tier per representative width, Rail showing title only", () => {
		expect(densityTier(180)).toBe("rail");
		expect(columnsForTier("rail")).toEqual(["name"]);
		expect(densityTier(300)).toBe("list");
		expect(columnsForTier("list")).toEqual(["name", "modified"]);
		expect(densityTier(450)).toBe("card");
		expect(columnsForTier("card")).toEqual([
			"name",
			"modified",
			"folder",
			"tags",
		]);
		expect(densityTier(700)).toBe("table");
		expect(columnsForTier("table")).toEqual([
			"name",
			"modified",
			"folder",
			"tags",
		]);
	});

	it("clamps the drag at both ends: rail floor and document floor", () => {
		expect(
			clampPeekListWidth({ availableWidth: 1400, desiredWidth: 40 }).listWidth,
		).toBe(NAV_RAIL_MIN_WIDTH);
		const clamped = clampPeekListWidth({
			availableWidth: 1000,
			desiredWidth: 900,
		});
		expect(clamped.listWidth).toBe(1000 - PEEK_DOCUMENT_MIN_WIDTH);
		expect(clamped.documentWidth).toBe(PEEK_DOCUMENT_MIN_WIDTH);
		expect(clamped.outcome).toBe("clamped");
	});

	it("derives pointer position direction-aware, never negative", () => {
		expect(
			listWidthFromPointer({
				clientX: 500,
				splitRectLeft: 0,
				splitRectRight: 1000,
				direction: "ltr",
			}),
		).toBe(500);
		expect(
			listWidthFromPointer({
				clientX: 500,
				splitRectLeft: 0,
				splitRectRight: 1000,
				direction: "rtl",
			}),
		).toBe(500);
		expect(
			listWidthFromPointer({
				clientX: -50,
				splitRectLeft: 0,
				splitRectRight: 1000,
				direction: "ltr",
			}),
		).toBe(0);
	});
});

describe("PeekListDivider drag interaction", () => {
	let container: HTMLDivElement;
	let root: Root;
	let splitEl: HTMLDivElement;
	let onResize: ReturnType<typeof vi.fn>;

	function rectFor() {
		return {
			x: 0,
			y: 0,
			top: 0,
			left: 0,
			bottom: 0,
			right: 1000,
			width: 1000,
			height: 600,
			toJSON: () => ({}),
		} as DOMRect;
	}

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		splitEl = document.createElement("div");
		document.body.append(splitEl);
		vi.spyOn(splitEl, "getBoundingClientRect").mockImplementation(() =>
			rectFor(),
		);
		onResize = vi.fn();
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		splitEl.remove();
		vi.restoreAllMocks();
	});

	function renderDivider(listWidth = 300) {
		const splitRef = { current: splitEl };
		act(() => {
			root.render(
				<PeekListDivider
					splitRef={splitRef}
					listWidth={listWidth}
					onResize={onResize}
				/>,
			);
		});
		return container.querySelector<HTMLElement>("[data-peek-list-divider]");
	}

	it("dragging reports the pointer-derived width and flags the container", () => {
		const divider = renderDivider();
		expect(divider).not.toBeNull();

		act(() => {
			divider?.dispatchEvent(
				new MouseEvent("mousedown", { bubbles: true, clientX: 300 }),
			);
		});
		expect(splitEl.hasAttribute("data-resizing")).toBe(true);

		act(() => {
			window.dispatchEvent(
				new MouseEvent("mousemove", { bubbles: true, clientX: 500 }),
			);
		});
		expect(onResize).toHaveBeenCalledWith(500);

		act(() => {
			window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
		});
		expect(splitEl.hasAttribute("data-resizing")).toBe(false);
	});

	it("a drag past the rail still reports raw; the clamp owns the floor", () => {
		const divider = renderDivider();
		act(() => {
			divider?.dispatchEvent(
				new MouseEvent("mousedown", { bubbles: true, clientX: 300 }),
			);
		});
		act(() => {
			window.dispatchEvent(
				new MouseEvent("mousemove", { bubbles: true, clientX: 10 }),
			);
		});
		expect(onResize).toHaveBeenCalledWith(10);
		expect(
			clampPeekListWidth({ availableWidth: 1000, desiredWidth: 10 }).listWidth,
		).toBe(NAV_RAIL_MIN_WIDTH);
		act(() => {
			window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
		});
	});

	it("arrow keys nudge the width without a pointer", () => {
		const divider = renderDivider(300);
		act(() => {
			divider?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }),
			);
		});
		expect(onResize).toHaveBeenCalledWith(316);
	});
});

describe("useNavContainerWidth", () => {
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

	it("mounts without throwing and reports numbers; one element reads equal (EC-70)", () => {
		const seen: {
			current: { splitWidth: number; listWidth: number } | null;
		} = { current: null };
		function Probe() {
			const splitRef = useRef<HTMLDivElement | null>(null);
			// Browse: a single container, so both observers read the same element.
			const widths = useNavContainerWidth(splitRef, splitRef);
			seen.current = widths;
			return <div ref={splitRef} />;
		}
		act(() => {
			root.render(<Probe />);
		});
		expect(seen.current).not.toBeNull();
		expect(typeof seen.current?.splitWidth).toBe("number");
		expect(typeof seen.current?.listWidth).toBe("number");
		expect(seen.current?.splitWidth).toBe(seen.current?.listWidth);
	});
});

describe("peek list width persistence", () => {
	beforeEach(() => {
		// The store middleware writes through `localStorage` on every set.
		vi.stubGlobal("localStorage", {
			getItem: vi.fn(() => null),
			setItem: vi.fn(),
			removeItem: vi.fn(),
		});
	});

	afterEach(() => {
		workspaceStore.set((state) => {
			const peekListWidths = { ...state.peekListWidths };
			delete peekListWidths[REMOUNT_WORKSPACE];
			return { ...state, peekListWidths };
		});
		vi.unstubAllGlobals();
	});

	it("round-trips: write a width, remount, the width comes back", () => {
		setPeekListDesiredWidth(REMOUNT_WORKSPACE, 400);
		expect(getPeekListDesiredWidth(REMOUNT_WORKSPACE)).toBe(400);

		// Simulate a remount through the real serialize/hydrate path.
		const snapshot = JSON.stringify(serialize(appStore.get()));
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => (key === STORAGE_KEY ? snapshot : null),
			setItem: vi.fn(),
			removeItem: vi.fn(),
		});
		const fresh = getInitialState();
		expect(fresh.workspace.peekListWidths[REMOUNT_WORKSPACE]).toBe(400);
	});

	it("falls back to the default for unknown workspaces", () => {
		expect(getPeekListDesiredWidth("/ws-never-seen")).toBe(
			PEEK_LIST_DEFAULT_WIDTH,
		);
	});
});

describe("DocumentNarrowList density tiers", () => {
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

	function secondaryCount(): number {
		return Array.from(
			container.querySelectorAll<HTMLElement>("[data-document-row-index]"),
		).filter(
			(row) => row.querySelector('[role="gridcell"]')?.children.length === 2,
		).length;
	}

	function bodyRows(): HTMLElement[] {
		return Array.from(
			container.querySelectorAll<HTMLElement>("[data-document-row-index]"),
		);
	}

	function renderTier(navTier: "rail" | "list" | "card" | "table") {
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

	function rowMeta(row: HTMLElement): Element | null {
		return row.querySelector('[role="gridcell"]')?.children[1] ?? null;
	}

	it("Rail shows titles only; List keeps the secondary line", () => {
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
					navTier="rail"
				/>,
			);
		});
		expect(
			container.querySelector("[data-nav-tier]")?.getAttribute("data-nav-tier"),
		).toBe("rail");
		expect(secondaryCount()).toBe(0);

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
					navTier="list"
				/>,
			);
		});
		expect(secondaryCount()).toBeGreaterThan(0);
	});

	it("steps the fixed row height up with the tier, so the virtualizer stays uniform", () => {
		expect(documentRowHeight("table")).toBe(28);
		expect(documentRowHeight("list", "rail")).toBe(DOCUMENT_LIST_ROW_HEIGHT);
		expect(documentRowHeight("list", "list")).toBe(DOCUMENT_CARD_ROW_HEIGHT);
		expect(documentRowHeight("list", "card")).toBe(DOCUMENT_CARD_ROW_HEIGHT);
		expect(documentRowHeight("list", "table")).toBe(
			DOCUMENT_NARROW_TABLE_ROW_HEIGHT,
		);
		expect(DOCUMENT_CARD_ROW_HEIGHT).toBeGreaterThan(DOCUMENT_LIST_ROW_HEIGHT);
		expect(DOCUMENT_NARROW_TABLE_ROW_HEIGHT).toBeGreaterThan(
			DOCUMENT_CARD_ROW_HEIGHT,
		);
	});

	it("List wraps the 2nd info too — wrapping starts wherever it appears", () => {
		renderTier("list");

		const rows = bodyRows();
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[0].style.blockSize).toBe(`${DOCUMENT_CARD_ROW_HEIGHT}px`);
		const meta = rowMeta(rows[0]);
		expect(meta?.className).toContain("line-clamp-2");
		expect(meta?.textContent).toContain("—");
		expect(meta?.textContent).toContain(formatModifiedAt(1_700_000_300));
	});

	it("Card wraps every data column into a two-line meta block", () => {
		renderTier("card");

		const rows = bodyRows();
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[0].style.blockSize).toBe(`${DOCUMENT_CARD_ROW_HEIGHT}px`);
		const meta = rowMeta(rows[0]);
		expect(meta?.className).toContain("line-clamp-2");
		// Default order is name/folder/modified/created: the card carries the
		// folder AND both dates, where List showed the folder alone.
		expect(meta?.textContent).toContain("—");
		expect(meta?.textContent).toContain(formatModifiedAt(1_700_000_300));
	});

	it("Table allows the meta a third line, so widening reveals more info", () => {
		renderTier("table");

		const rows = bodyRows();
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[0].style.blockSize).toBe(
			`${DOCUMENT_NARROW_TABLE_ROW_HEIGHT}px`,
		);
		const meta = rowMeta(rows[0]);
		expect(meta?.className).toContain("line-clamp-3");
		expect(meta?.textContent).toContain("—");
		expect(meta?.textContent).toContain(formatModifiedAt(1_700_000_300));
	});

	it("Card shows dates the List tier hides (created distinct from modified)", () => {
		const files: FileEntry[] = [
			{
				path: "/ws/alpha.md",
				modified_at: 1_700_000_300,
				created_at: 1_600_000_000,
			},
		];
		act(() => {
			root.render(
				<DocumentNarrowList
					rows={buildRows({ files })}
					view={viewWith()}
					listing={LISTED}
					onOpenDocument={vi.fn()}
					onFilterChange={vi.fn()}
					onShowAllDocuments={vi.fn()}
					onRetryListing={vi.fn()}
					navTier="card"
				/>,
			);
		});

		const meta = rowMeta(bodyRows()[0]);
		expect(meta?.textContent).toContain(formatModifiedAt(1_700_000_300));
		expect(meta?.textContent).toContain(formatModifiedAt(1_600_000_000));
	});
});
