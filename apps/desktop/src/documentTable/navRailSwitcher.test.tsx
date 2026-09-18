// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getInitialState, serialize } from "../store/persistence";
import { appStore, workspaceStore } from "../store/state";
import { STORAGE_KEY } from "../store/storage";
import { DocumentNarrowList } from "./DocumentNarrowList";
import { DocumentTable } from "./DocumentTable";
import type { DocumentListingState } from "./documentListingState";
import {
	documentTableViewStore,
	setDocumentTableGroupBy,
} from "./documentTableStore";
import { resolveNavViewSpec } from "./navGroupTree";
import { getNavHiddenViews, toggleHiddenView } from "./navHiddenViews";
import { buildRows, viewWith } from "./testFixtures";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LISTED: DocumentListingState = { kind: "listed" };
const WORKSPACE = "/ws";

function setWorkspace(path: string | null) {
	workspaceStore.set((state) => ({ ...state, workspacePath: path }));
}

function clearHiddenViews() {
	workspaceStore.set((state) => ({ ...state, navHiddenViews: {} }));
}

describe("rail view switcher (A12)", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		setWorkspace(WORKSPACE);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		setDocumentTableGroupBy(null);
		setWorkspace(null);
		clearHiddenViews();
		vi.unstubAllGlobals();
	});

	function renderNarrow(navTier: "rail" | "list", view = viewWith()) {
		act(() => {
			root.render(
				<DocumentNarrowList
					rows={buildRows({ view })}
					view={view}
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

	function dotViews(): (string | null)[] {
		return Array.from(
			container.querySelectorAll<HTMLElement>("[data-nav-view-dot]"),
		).map((el) => el.getAttribute("data-nav-view-dot"));
	}

	it("renders exactly 2 dots at Rail and the inline switcher above Rail", () => {
		renderNarrow("rail");
		expect(dotViews()).toEqual(["folder", "tag"]);
		expect(container.querySelector("[data-nav-view-switcher]")).toBeNull();

		renderNarrow("list");
		expect(container.querySelector("[data-nav-view-dots]")).toBeNull();
		expect(container.querySelector("[data-nav-view-switcher]")).not.toBeNull();
	});

	it("renders the inline switcher (never dots) in the full-width table", () => {
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
		expect(container.querySelector("[data-nav-view-switcher]")).not.toBeNull();
		expect(container.querySelector("[data-nav-view-dots]")).toBeNull();
	});

	it("clicking a dot selects the view; clicking it again returns to flat", async () => {
		renderNarrow("rail");
		const folder = container.querySelector<HTMLElement>(
			'[data-nav-view-dot="folder"]',
		);
		expect(folder).not.toBeNull();

		await act(async () => {
			folder?.click();
		});
		expect(documentTableViewStore.get().groupBy).toBe("folder");

		await act(async () => {
			container
				.querySelector<HTMLElement>('[data-nav-view-dot="folder"]')
				?.click();
		});
		expect(documentTableViewStore.get().groupBy).toBeNull();
	});

	it("wheel right advances folder to tag", async () => {
		setDocumentTableGroupBy("folder");
		renderNarrow("rail");
		const strip = container.querySelector<HTMLElement>("[data-nav-view-dots]");
		expect(strip).not.toBeNull();

		await act(async () => {
			strip?.dispatchEvent(
				new WheelEvent("wheel", { deltaX: 70, deltaY: 0, bubbles: true }),
			);
		});
		expect(documentTableViewStore.get().groupBy).toBe("tag");
	});

	it("wheel at the last dot stays clamped — no wrap-around", async () => {
		setDocumentTableGroupBy("tag");
		renderNarrow("rail");
		const strip = container.querySelector<HTMLElement>("[data-nav-view-dots]");
		await act(async () => {
			strip?.dispatchEvent(
				new WheelEvent("wheel", { deltaX: 70, deltaY: 0, bubbles: true }),
			);
		});
		expect(documentTableViewStore.get().groupBy).toBe("tag");
	});

	it("wheel left returns tag to folder", async () => {
		setDocumentTableGroupBy("tag");
		renderNarrow("rail");
		const strip = container.querySelector<HTMLElement>("[data-nav-view-dots]");
		await act(async () => {
			strip?.dispatchEvent(
				new WheelEvent("wheel", { deltaX: -70, deltaY: 0, bubbles: true }),
			);
		});
		expect(documentTableViewStore.get().groupBy).toBe("folder");
	});

	it("right-click hides a dot; the last remaining view shows with no strip", async () => {
		setDocumentTableGroupBy("folder");
		renderNarrow("rail");

		await act(async () => {
			container
				.querySelector<HTMLElement>('[data-nav-view-dot="folder"]')
				?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		});
		expect(getNavHiddenViews(WORKSPACE)).toEqual(["folder"]);
		// Hiding the active view falls back to the remainder.
		expect(documentTableViewStore.get().groupBy).toBe("tag");
		// One view left: no strip, nothing to switch between.
		expect(container.querySelector("[data-nav-view-dots]")).toBeNull();
	});

	it("hiding the last visible view is a no-op", () => {
		expect(toggleHiddenView(["folder"], "tag")).toBeNull();
		expect(toggleHiddenView([], "folder")).toEqual(["folder"]);
		expect(toggleHiddenView(["folder"], "folder")).toEqual([]);
	});

	it("hidden views persist per workspace and restore from the inline switcher", async () => {
		setDocumentTableGroupBy("folder");
		renderNarrow("rail");
		await act(async () => {
			container
				.querySelector<HTMLElement>('[data-nav-view-dot="folder"]')
				?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		});

		const snapshot = JSON.stringify(serialize(appStore.get()));
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => (key === STORAGE_KEY ? snapshot : null),
			setItem: vi.fn(),
			removeItem: vi.fn(),
		});
		expect(getInitialState().workspace.navHiddenViews[WORKSPACE]).toEqual([
			"folder",
		]);

		// Wider tiers always offer both views: selecting restores the hidden one.
		renderNarrow("list");
		const folderOption = container.querySelector<HTMLElement>(
			'[data-nav-view-option="folder"]',
		);
		expect(folderOption).not.toBeNull();
		await act(async () => {
			folderOption?.click();
		});
		expect(getNavHiddenViews(WORKSPACE)).toEqual([]);
		expect(documentTableViewStore.get().groupBy).toBe("folder");
	});

	it("search mode keeps exactly the 2 view dots — search is not a dot", () => {
		const searchView = viewWith({ mode: "search", filter: "budget" });
		renderNarrow("rail", searchView);
		expect(dotViews()).toEqual(["folder", "tag"]);
	});

	it("EC-110: entering search still suspends Pinned per A7, unchanged", () => {
		const searching = resolveNavViewSpec({
			groupBy: "folder",
			mode: "search",
			filter: "budget",
		});
		expect(searching.groupBy).toBeNull();
		expect(searching.pinnedSection).toBe(false);
		expect(searching.ranked).toBe(true);

		const browsing = resolveNavViewSpec({
			groupBy: "tag",
			mode: "browse",
			filter: "",
		});
		expect(browsing.groupBy).toBe("tag");
		expect(browsing.pinnedSection).toBe(true);
	});
});
