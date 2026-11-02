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
	saveCurrentViewAs,
	selectSavedView,
	setDocumentTableGroupBy,
	setDocumentTableSort,
} from "./documentTableStore";
import {
	getSavedViews,
	loadWorkspaceSavedViews,
	setViewStoreFactoryForTest,
} from "./documentViewsFileStore";
import { getNavViewSort } from "./navViewSort";
import { buildRows, viewWith } from "./testFixtures";
import { createLocalStorageViewStore } from "./viewStores";

/** Saved views R1, R2, R4, R5, R6: saved views as icons in the view switcher. */

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LISTED: DocumentListingState = { kind: "listed" };
const WORKSPACE = "/ws-icons";
const LONG_NAME = "A very long saved view name that will not fit in the row";

describe("saved views in the view switcher", () => {
	let container: HTMLDivElement;
	let root: Root;
	let now: number;

	beforeEach(async () => {
		const map = new Map<string, string>();
		setViewStoreFactoryForTest((ws) =>
			createLocalStorageViewStore(
				{
					getItem: (k) => map.get(k) ?? null,
					setItem: (k, v) => void map.set(k, v),
				},
				ws,
			),
		);
		workspaceStore.set((state) => ({
			...state,
			workspacePath: WORKSPACE,
			navHiddenViews: {},
			selectedSavedViews: {},
		}));
		await loadWorkspaceSavedViews(WORKSPACE);
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
	});

	afterEach(() => {
		act(() => root.unmount());
		document.body.innerHTML = "";
		selectSavedView(null);
		setDocumentTableGroupBy(null);
		workspaceStore.set((state) => ({
			...state,
			workspacePath: null,
			navHiddenViews: {},
			selectedSavedViews: {},
		}));
		setViewStoreFactoryForTest(null);
		vi.restoreAllMocks();
	});

	function renderNarrow(navTier: "rail" | "list") {
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

	function renderTable(view = viewWith()) {
		act(() => {
			root.render(
				<DocumentTable
					rows={buildRows()}
					view={view}
					listing={LISTED}
					onOpenDocument={vi.fn()}
					onFilterChange={vi.fn()}
					onToggleSort={vi.fn()}
					onRetryListing={vi.fn()}
				/>,
			);
		});
	}

	const dots = () =>
		[...container.querySelectorAll("[data-nav-view-dot]")].map((el) =>
			el.getAttribute("data-nav-view-dot"),
		);
	const inline = () =>
		[...container.querySelectorAll("[data-nav-view-option]")].map((el) =>
			el.getAttribute("data-nav-view-option"),
		);

	function saveTwo() {
		const a = saveCurrentViewAs("Due") as string;
		const b = saveCurrentViewAs(LONG_NAME) as string;
		selectSavedView(null);
		return { a, b };
	}

	it("R1: each saved view is a dot after the visible built-ins, in file order", () => {
		const { a, b } = saveTwo();
		workspaceStore.set((state) => ({
			...state,
			navHiddenViews: { [WORKSPACE]: ["folder"] },
		}));
		renderNarrow("rail");
		expect(dots()).toEqual(["recent", "tag", `saved:${a}`, `saved:${b}`]);
	});

	it("R1: inline buttons include saved views in the same order; clicking applies the view", async () => {
		const { a, b } = saveTwo();
		renderNarrow("list");
		expect(inline()).toEqual([
			"recent",
			"folder",
			"tag",
			`saved:${a}`,
			`saved:${b}`,
		]);
		const button = container.querySelector<HTMLElement>(
			`[data-nav-view-option="saved:${a}"]`,
		);
		await act(async () => button?.click());
		expect(documentTableViewStore.get().activeSavedViewId).toBe(a);
		expect(
			container
				.querySelector(`[data-nav-view-option="saved:${a}"]`)
				?.getAttribute("aria-pressed"),
		).toBe("true");
		expect(
			container
				.querySelector('[data-nav-view-option="recent"]')
				?.getAttribute("aria-pressed"),
		).toBe("false");
		// Back to Recent leaves the saved view.
		await act(async () =>
			container
				.querySelector<HTMLElement>('[data-nav-view-option="recent"]')
				?.click(),
		);
		expect(documentTableViewStore.get().activeSavedViewId).toBeNull();
	});

	it("R2: a long name truncates in the row with the full name as tooltip", () => {
		const { b } = saveTwo();
		renderNarrow("list");
		const button = container.querySelector(
			`[data-nav-view-option="saved:${b}"]`,
		);
		expect(button?.getAttribute("title")).toContain(LONG_NAME);
		expect(button?.querySelector(".truncate")?.textContent).toBe(LONG_NAME);
		renderNarrow("rail");
		expect(
			container
				.querySelector(`[data-nav-view-dot="saved:${b}"]`)
				?.getAttribute("title"),
		).toContain(LONG_NAME);
	});

	it("R1: swipe walks built-ins then saved views", async () => {
		const { a } = saveTwo();
		renderNarrow("list");
		const region = () => {
			const groups =
				container.querySelectorAll<HTMLElement>('[role="rowgroup"]');
			return groups[groups.length - 1];
		};
		const swipe = async (deltaX: number) => {
			await act(async () => {
				region()?.dispatchEvent(
					new WheelEvent("wheel", { deltaX, deltaY: 0, bubbles: true }),
				);
			});
			now += 1_000;
		};
		await swipe(80);
		await swipe(80);
		expect(documentTableViewStore.get().groupBy).toBe("tag");
		await swipe(80);
		expect(documentTableViewStore.get().activeSavedViewId).toBe(a);
		await swipe(-80);
		expect(documentTableViewStore.get().activeSavedViewId).toBeNull();
		expect(documentTableViewStore.get().groupBy).toBe("tag");
	});

	it("R3: before the remembered view has loaded, a swipe cannot replace it", async () => {
		renderNarrow("list");
		await act(async () => {
			documentTableViewStore.set((view) => ({
				...view,
				activeSavedViewId: "not-loaded-yet",
			}));
		});
		const groups = container.querySelectorAll<HTMLElement>('[role="rowgroup"]');
		await act(async () => {
			groups[groups.length - 1]?.dispatchEvent(
				new WheelEvent("wheel", { deltaX: 80, deltaY: 0, bubbles: true }),
			);
		});
		expect(documentTableViewStore.get().activeSavedViewId).toBe(
			"not-loaded-yet",
		);
		expect(documentTableViewStore.get().groupBy).toBeNull();
	});

	function openMenu(key: string, attr = "data-nav-view-option") {
		const el = container.querySelector<HTMLElement>(`[${attr}="${key}"]`);
		act(() => {
			el?.dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
			);
		});
	}
	const menuItem = (label: string) =>
		[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
			(item) => item.textContent?.includes(label),
		);

	it("R2: rename from the icon's context menu; invalid names show an error and write nothing", async () => {
		const { a } = saveTwo();
		renderNarrow("rail");
		openMenu(`saved:${a}`, "data-nav-view-dot");
		await act(async () => menuItem("Rename")?.click());
		await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
		const input = container.querySelector<HTMLInputElement>(
			'input[aria-label="View name"]',
		);
		expect(input).not.toBeNull();
		const type = async (value: string) => {
			await act(async () => {
				const setter = Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value",
				)?.set;
				setter?.call(input, value);
				input?.dispatchEvent(new Event("input", { bubbles: true }));
			});
			await act(async () => {
				input?.dispatchEvent(
					new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
				);
			});
		};
		await type("recent");
		expect(container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
		expect(getSavedViews(WORKSPACE).find((v) => v.id === a)?.name).toBe("Due");
		await type("  Overdue ");
		expect(getSavedViews(WORKSPACE).find((v) => v.id === a)?.name).toBe(
			"Overdue",
		);
		expect(container.querySelector('input[aria-label="View name"]')).toBeNull();
	});

	it("R3: delete from the context menu; deleting the active view lands on Recent", async () => {
		const { a } = saveTwo();
		selectSavedView(a);
		renderNarrow("list");
		openMenu(`saved:${a}`);
		await act(async () => menuItem("Delete")?.click());
		expect(getSavedViews(WORKSPACE).some((v) => v.id === a)).toBe(false);
		expect(documentTableViewStore.get().activeSavedViewId).toBeNull();
		expect(
			container
				.querySelector('[data-nav-view-option="recent"]')
				?.getAttribute("aria-pressed"),
		).toBe("true");
	});

	it("R4: built-ins get no rename/delete menu, and hiding never stores a saved id", async () => {
		const { a } = saveTwo();
		renderNarrow("list");
		openMenu("folder");
		expect(menuItem("Rename")).toBeUndefined();
		openMenu(`saved:${a}`);
		expect(workspaceStore.get().navHiddenViews[WORKSPACE] ?? []).not.toContain(
			a,
		);
		expect(JSON.stringify(workspaceStore.get().navHiddenViews)).not.toContain(
			a,
		);
	});

	it("R6: the table header has no saved-view tabs; 'Save view…' creates and selects a new icon", async () => {
		saveTwo();
		renderTable(
			viewWith({ propertyFilters: [{ fieldId: "prop:status", kind: "has" }] }),
		);
		expect(container.querySelector('nav[aria-label="Saved views"]')).toBeNull();
		expect(container.textContent).not.toContain("All documents");
		const save = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Save view…",
		);
		expect(save).toBeDefined();
		await act(async () => save?.click());
		const input = container.querySelector<HTMLInputElement>(
			'input[aria-label="View name"]',
		);
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set?.call(input, "Fresh");
			input?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			input?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
		});
		const fresh = getSavedViews(WORKSPACE).find((v) => v.name === "Fresh");
		expect(fresh).toBeDefined();
		expect(documentTableViewStore.get().activeSavedViewId).toBe(fresh?.id);
		expect(inline()).toContain(`saved:${fresh?.id}`);
	});

	it("the header sort button shows and edits the active saved view's sort, not Recent's", async () => {
		const { a } = saveTwo();
		await act(async () => {
			selectSavedView(a);
		});
		await act(async () => {
			setDocumentTableSort({ column: "name", direction: "asc" });
		});
		renderNarrow("list");
		await act(async () => {});
		const button = () =>
			container.querySelector(
				'[data-nav-list-header] button[aria-label="Sort documents"]',
			) as HTMLButtonElement;
		expect(getNavViewSort(WORKSPACE, "recent").column).toBe("modified");
		expect(button().getAttribute("aria-pressed")).toBe("true");
		await act(async () => {
			button().click();
		});
		expect(getSavedViews(WORKSPACE).find((v) => v.id === a)?.sort).toEqual({
			column: "modified",
			direction: "desc",
		});
		expect(getNavViewSort(WORKSPACE, "recent").column).toBe("modified");
		expect(button().getAttribute("aria-pressed")).toBe("false");
	});
});
