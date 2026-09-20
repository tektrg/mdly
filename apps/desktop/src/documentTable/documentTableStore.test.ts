import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The view store lives outside `appStore`, so it has to be imported fresh (with
 * a stubbed localStorage for the store module graph) exactly like the action
 * tests do.
 */
async function loadDocumentTableStore() {
	vi.resetModules();
	const setItem = vi.fn();
	vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem });
	const tableStore = await import("./documentTableStore");
	const state = await import("../store/state");
	return { ...tableStore, ...state, setItem };
}

describe("documentTableStore", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("defaults to an empty filter on the recent (flat) view, with no sort of its own", async () => {
		const { documentTableViewStore } = await loadDocumentTableStore();

		expect(documentTableViewStore.get()).toEqual({
			filter: "",
			groupBy: null,
			mode: "browse",
		});
	});

	it("keeps the persisted sort while the filter changes", async () => {
		const {
			documentTableViewStore,
			setDocumentTableFilter,
			toggleDocumentTableSort,
			workspaceStore,
			workspacePathStore,
		} = await loadDocumentTableStore();
		workspacePathStore.set("/ws");
		await new Promise((resolve) => setTimeout(resolve, 0));

		toggleDocumentTableSort("name");
		setDocumentTableFilter("spec");

		expect(documentTableViewStore.get()).toEqual({
			filter: "spec",
			groupBy: null,
			mode: "browse",
		});
		expect(workspaceStore.get().navViewSorts["/ws"]).toEqual({
			recent: { column: "name", direction: "asc" },
		});
	});

	it("forgets the filter, the grouping and the mode on a workspace switch, but keeps each workspace's sorts", async () => {
		const {
			documentTableViewStore,
			setDocumentTableFilter,
			setDocumentTableGroupBy,
			setDocumentTableMode,
			toggleDocumentTableSort,
			workspaceStore,
			workspacePathStore,
		} = await loadDocumentTableStore();
		workspacePathStore.set("/ws");
		await new Promise((resolve) => setTimeout(resolve, 0));

		setDocumentTableFilter("spec");
		toggleDocumentTableSort("name");
		setDocumentTableGroupBy("tag");
		setDocumentTableMode("search");
		workspacePathStore.set("/other-workspace");
		// Store notifications are delivered on a microtask.
		await new Promise((resolve) => setTimeout(resolve, 0));

		// EC-72: the view resets on a switch the way the sidebar's active page
		// did, and one store owns all three fields so none can survive alone.
		expect(documentTableViewStore.get()).toEqual({
			filter: "",
			groupBy: null,
			mode: "browse",
		});
		// Sort is persisted per workspace, not session state: it stays put.
		expect(workspaceStore.get().navViewSorts["/ws"]?.recent).toEqual({
			column: "name",
			direction: "asc",
		});
	});

	it("keeps a separate sort per view: sorting tag by name leaves folder and recent alone", async () => {
		const {
			setDocumentTableGroupBy,
			toggleDocumentTableSort,
			workspaceStore,
			workspacePathStore,
		} = await loadDocumentTableStore();
		workspacePathStore.set("/ws");
		await new Promise((resolve) => setTimeout(resolve, 0));

		setDocumentTableGroupBy("tag");
		toggleDocumentTableSort("name");
		setDocumentTableGroupBy("folder");
		toggleDocumentTableSort("modified");

		expect(workspaceStore.get().navViewSorts["/ws"]).toEqual({
			tag: { column: "name", direction: "asc" },
			// Modified is already the default (desc), so a click flips it.
			folder: { column: "modified", direction: "asc" },
		});
	});

	it("carries grouping and mode on the one view store (defect 4)", async () => {
		const {
			documentTableViewStore,
			setDocumentTableGroupBy,
			setDocumentTableMode,
			setDocumentTableFilter,
		} = await loadDocumentTableStore();

		setDocumentTableGroupBy("folder");
		setDocumentTableMode("search");
		setDocumentTableFilter("q");

		expect(documentTableViewStore.get()).toMatchObject({
			groupBy: "folder",
			mode: "search",
			filter: "q",
		});
	});

	it("never writes the filter to persisted storage", async () => {
		const { setDocumentTableFilter, setItem } = await loadDocumentTableStore();

		setDocumentTableFilter("secret-query");

		for (const call of setItem.mock.calls) {
			expect(String(call[1])).not.toContain("secret-query");
		}
	});
});
