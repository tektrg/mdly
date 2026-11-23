// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	currentPathStore,
	showViewBarStore,
	workspaceStore,
} from "../store/state";
import { DocumentNarrowList } from "./DocumentNarrowList";
import type { DocumentListingState } from "./documentListingState";
import {
	documentTableViewStore,
	saveCurrentViewAs,
	selectSavedView,
	setDocumentTableGroupBy,
} from "./documentTableStore";
import {
	getSavedViews,
	loadWorkspaceSavedViews,
	setViewStoreFactoryForTest,
} from "./documentViewsFileStore";
import { NavListHeader } from "./NavListHeader";
import { NavViewBar } from "./NavViewBar";
import { buildRows, viewWith } from "./testFixtures";
import { createLocalStorageViewStore } from "./viewStores";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LISTED: DocumentListingState = { kind: "listed" };
const WORKSPACE = "/ws-bar";

function dragData() {
	const data: Record<string, string> = {};
	return {
		effectAllowed: "none",
		dropEffect: "none",
		setData: (key: string, value: string) => {
			data[key] = value;
		},
		getData: (key: string) => data[key] ?? "",
	};
}

function fireDrag(
	target: Element,
	type: "dragstart" | "dragover" | "drop" | "dragend",
	dataTransfer: ReturnType<typeof dragData>,
) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	(event as Event & { dataTransfer?: unknown }).dataTransfer = dataTransfer;
	act(() => {
		target.dispatchEvent(event);
	});
}

describe("left view bar", () => {
	let container: HTMLDivElement;
	let root: Root;

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
	});

	afterEach(() => {
		act(() => root.unmount());
		document.body.innerHTML = "";
		selectSavedView(null);
		setDocumentTableGroupBy(null);
		showViewBarStore.set(false);
		workspaceStore.set((state) => ({
			...state,
			workspacePath: null,
			navHiddenViews: {},
			selectedSavedViews: {},
		}));
		setViewStoreFactoryForTest(null);
		vi.restoreAllMocks();
	});

	const bar = () => {
		act(() => root.render(<NavViewBar />));
	};
	const options = () =>
		Array.from(
			container.querySelectorAll<HTMLElement>("[data-nav-view-bar-option]"),
		);
	const keys = () =>
		options().map((el) => el.getAttribute("data-nav-view-bar-option"));
	const option = (key: string) =>
		container.querySelector<HTMLElement>(
			`[data-nav-view-bar-option="${key}"]`,
		) as HTMLElement;

	it("lists built-ins then saved views, marks the active one, and selects on click", async () => {
		const a = saveCurrentViewAs("Alpha") as string;
		const b = saveCurrentViewAs("Beta") as string;
		selectSavedView(null);
		bar();
		expect(keys()).toEqual([
			"recent",
			"folder",
			"tag",
			`saved:${a}`,
			`saved:${b}`,
		]);
		expect(option("recent").getAttribute("aria-pressed")).toBe("true");
		expect(option(`saved:${a}`).getAttribute("aria-label")).toBe("Alpha view");
		expect(option(`saved:${a}`).title).toBe("Alpha");

		await act(async () => option("folder").click());
		expect(documentTableViewStore.get().groupBy).not.toBeNull();
		expect(option("folder").getAttribute("aria-pressed")).toBe("true");

		await act(async () => option(`saved:${b}`).click());
		expect(documentTableViewStore.get().activeSavedViewId).toBe(b);
		expect(option(`saved:${b}`).getAttribute("aria-pressed")).toBe("true");
	});

	it("keeps an open document open when a view is picked", async () => {
		currentPathStore.set("/ws-bar/note.md");
		bar();
		await act(async () => option("tag").click());
		expect(currentPathStore.get()).toBe("/ws-bar/note.md");
		currentPathStore.set(undefined);
	});

	it("hides a built-in on right-click and leaves it out of the bar", async () => {
		bar();
		await act(async () => {
			option("tag").dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
			);
		});
		expect(keys()).toEqual(["recent", "folder"]);
	});

	it("opens the saved-view menu on right-click", async () => {
		const a = saveCurrentViewAs("Alpha") as string;
		bar();
		await act(async () => {
			option(`saved:${a}`).dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
			);
		});
		const items = Array.from(
			document.body.querySelectorAll('[role="menuitem"]'),
		).map((el) => el.textContent);
		expect(items.some((text) => text?.includes("Rename"))).toBe(true);
		expect(items.some((text) => text?.includes("Delete"))).toBe(true);
	});

	it("drags a saved view before another to reorder; built-ins don't drag", () => {
		const a = saveCurrentViewAs("Alpha") as string;
		const b = saveCurrentViewAs("Beta") as string;
		const c = saveCurrentViewAs("Gamma") as string;
		bar();
		expect(option("recent").getAttribute("draggable")).toBe("false");
		const dt = dragData();
		fireDrag(option(`saved:${c}`), "dragstart", dt);
		fireDrag(option(`saved:${a}`), "dragover", dt);
		fireDrag(option(`saved:${a}`), "drop", dt);
		expect(getSavedViews(WORKSPACE).map((view) => view.id)).toEqual([c, a, b]);
		expect(keys().slice(3)).toEqual([`saved:${c}`, `saved:${a}`, `saved:${b}`]);
	});

	it("hides only the list header's switcher while the bar is on", () => {
		showViewBarStore.set(true);
		act(() =>
			root.render(
				<NavListHeader
					variant="tabs"
					trailing={<span data-testid="trailing" />}
					end={<span data-testid="end" />}
				/>,
			),
		);
		expect(container.querySelector("[data-nav-view-switcher]")).toBeNull();
		expect(container.querySelector('[data-testid="trailing"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="end"]')).not.toBeNull();
		expect(
			container.querySelector('[aria-label="Sort documents"]'),
		).not.toBeNull();

		act(() =>
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
			),
		);
		expect(container.querySelector("[data-nav-view-dot]")).toBeNull();

		showViewBarStore.set(false);
		act(() => root.render(<NavListHeader variant="tabs" />));
		expect(container.querySelector("[data-nav-view-switcher]")).not.toBeNull();
	});
});
