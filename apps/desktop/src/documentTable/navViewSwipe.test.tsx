// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceStore } from "../store/state";
import { DocumentNarrowList } from "./DocumentNarrowList";
import { DocumentTable } from "./DocumentTable";
import type { DocumentListingState } from "./documentListingState";
import {
	documentTableViewStore,
	setDocumentTableGroupBy,
} from "./documentTableStore";
import { buildRows, viewWith } from "./testFixtures";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LISTED: DocumentListingState = { kind: "listed" };
const WORKSPACE = "/ws";

describe("nav view swipe over the list", () => {
	let container: HTMLDivElement;
	let root: Root;
	let now: number;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		workspaceStore.set((state) => ({ ...state, workspacePath: WORKSPACE }));
		now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
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
		vi.restoreAllMocks();
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

	function renderNarrow(navTier: "rail" | "list" | "card" | "table") {
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

	/** The scrollable list body — the table's header row is a rowgroup too. */
	function listRegion(): HTMLElement | undefined {
		const groups = container.querySelectorAll<HTMLElement>('[role="rowgroup"]');
		return groups[groups.length - 1];
	}

	/** One physical swipe: a wheel past the trigger, then the cooldown elapses. */
	async function swipe(deltaX: number) {
		const list = listRegion();
		expect(list).toBeDefined();
		await act(async () => {
			list?.dispatchEvent(
				new WheelEvent("wheel", { deltaX, deltaY: 0, bubbles: true }),
			);
		});
		now += 1_000;
	}

	it.each([
		["table", () => renderTable()],
		["narrow list", () => renderNarrow("list")],
		["rail", () => renderNarrow("rail")],
	])("swipes recent -> folder -> tag and clamps at both ends (%s)", async (_label, render) => {
		render();
		expect(documentTableViewStore.get().groupBy).toBeNull();

		await swipe(-80);
		expect(documentTableViewStore.get().groupBy).toBeNull();

		await swipe(80);
		expect(documentTableViewStore.get().groupBy).toBe("folder");
		await swipe(80);
		expect(documentTableViewStore.get().groupBy).toBe("tag");
		await swipe(80);
		expect(documentTableViewStore.get().groupBy).toBe("tag");

		await swipe(-80);
		expect(documentTableViewStore.get().groupBy).toBe("folder");
		await swipe(-80);
		expect(documentTableViewStore.get().groupBy).toBeNull();
	});

	it("leaves vertical scrolling alone", async () => {
		renderTable();
		const list = listRegion();
		const wheel = new WheelEvent("wheel", {
			deltaX: 0,
			deltaY: 200,
			bubbles: true,
			cancelable: true,
		});
		await act(async () => {
			list?.dispatchEvent(wheel);
		});
		expect(wheel.defaultPrevented).toBe(false);
		expect(documentTableViewStore.get().groupBy).toBeNull();
	});

	it("registers a non-passive wheel listener that claims a horizontal swipe", async () => {
		const added: { type: string; options: unknown }[] = [];
		const original = HTMLElement.prototype.addEventListener;
		vi.spyOn(HTMLElement.prototype, "addEventListener").mockImplementation(
			function (this: HTMLElement, type: string, ...rest: unknown[]) {
				if (type === "wheel") added.push({ type, options: rest[1] });
				return (original as (...args: unknown[]) => void).call(
					this,
					type,
					...rest,
				);
			} as typeof HTMLElement.prototype.addEventListener,
		);
		renderTable();
		expect(
			added.some(
				(call) => (call.options as { passive?: boolean })?.passive === false,
			),
		).toBe(true);

		const wheel = new WheelEvent("wheel", {
			deltaX: 80,
			deltaY: 0,
			bubbles: true,
			cancelable: true,
		});
		await act(async () => {
			listRegion()?.dispatchEvent(wheel);
		});
		expect(wheel.defaultPrevented).toBe(true);
		expect(documentTableViewStore.get().groupBy).toBe("folder");
	});

	it("removes the wheel listener on unmount", async () => {
		renderTable();
		const list = listRegion();
		act(() => root.render(<div />));
		now += 1_000;
		const wheel = new WheelEvent("wheel", {
			deltaX: 80,
			deltaY: 0,
			bubbles: true,
			cancelable: true,
		});
		await act(async () => {
			list?.dispatchEvent(wheel);
		});
		expect(wheel.defaultPrevented).toBe(false);
		expect(documentTableViewStore.get().groupBy).toBeNull();
	});

	function setOverflow(element: HTMLElement | undefined, overflowing: boolean) {
		Object.defineProperty(element, "scrollWidth", {
			configurable: true,
			value: overflowing ? 900 : 300,
		});
		Object.defineProperty(element, "clientWidth", {
			configurable: true,
			value: 300,
		});
	}

	it("lets a horizontally overflowing list scroll sideways instead of swiping", async () => {
		renderTable();
		setOverflow(listRegion(), true);
		const wheel = new WheelEvent("wheel", {
			deltaX: 80,
			deltaY: 0,
			bubbles: true,
			cancelable: true,
		});
		await act(async () => {
			listRegion()?.dispatchEvent(wheel);
		});
		expect(wheel.defaultPrevented).toBe(false);
		expect(documentTableViewStore.get().groupBy).toBeNull();

		setOverflow(listRegion(), false);
		await swipe(80);
		expect(documentTableViewStore.get().groupBy).toBe("folder");
	});

	it("resets the list scroll position when the grouping changes", () => {
		const renderGrouped = (groupBy: "folder" | null) =>
			act(() => {
				root.render(
					<DocumentTable
						rows={buildRows()}
						view={viewWith({ groupBy })}
						listing={LISTED}
						onOpenDocument={vi.fn()}
						onFilterChange={vi.fn()}
						onToggleSort={vi.fn()}
						onRetryListing={vi.fn()}
					/>,
				);
			});
		renderGrouped(null);
		const list = listRegion();
		expect(list).toBeDefined();
		if (list) list.scrollTop = 120;
		expect(list?.scrollTop).toBe(120);

		// The list follows the `view` prop, which the app derives from the store.
		renderGrouped("folder");
		expect(listRegion()?.scrollTop).toBe(0);
	});

	it("swipes over the empty-state container, and again once rows arrive", async () => {
		const empty: DocumentListingState = { kind: "listed" };
		const renderRows = (rows: ReturnType<typeof buildRows>) =>
			act(() => {
				root.render(
					<DocumentNarrowList
						rows={rows}
						view={viewWith()}
						listing={empty}
						onOpenDocument={vi.fn()}
						onFilterChange={vi.fn()}
						onShowAllDocuments={vi.fn()}
						onRetryListing={vi.fn()}
						navTier="list"
					/>,
				);
			});
		const emptyRegion = () =>
			container.querySelector<HTMLElement>(
				'[data-nav-list-header] ~ * [class*="overflow-auto"], [class*="overflow-auto"]',
			);
		const wheelOver = async (element: HTMLElement | null, deltaX: number) => {
			expect(element).not.toBeNull();
			await act(async () => {
				element?.dispatchEvent(
					new WheelEvent("wheel", { deltaX, deltaY: 0, bubbles: true }),
				);
			});
			now += 1_000;
		};

		renderRows([]);
		expect(container.querySelector('[role="rowgroup"]')).toBeNull();
		await wheelOver(emptyRegion(), 80);
		expect(documentTableViewStore.get().groupBy).toBe("folder");

		renderRows(buildRows());
		expect(container.querySelector('[role="rowgroup"]')).not.toBeNull();
		await wheelOver(listRegion() ?? null, 80);
		expect(documentTableViewStore.get().groupBy).toBe("tag");
	});

	it("swipes the inline switcher strip too", async () => {
		renderTable();
		const strip = container.querySelector<HTMLElement>(
			"[data-nav-view-switcher]",
		);
		await act(async () => {
			strip?.dispatchEvent(
				new WheelEvent("wheel", { deltaX: 80, deltaY: 0, bubbles: true }),
			);
		});
		expect(documentTableViewStore.get().groupBy).toBe("folder");
	});

	it("skips a hidden view when swiping", async () => {
		workspaceStore.set((state) => ({
			...state,
			navHiddenViews: { [WORKSPACE]: ["folder"] },
		}));
		renderTable();
		await swipe(80);
		expect(documentTableViewStore.get().groupBy).toBe("tag");
		workspaceStore.set((state) => ({ ...state, navHiddenViews: {} }));
	});
});
