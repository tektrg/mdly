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

	it("defaults to an empty filter sorted by modified, newest first", async () => {
		const { documentTableViewStore } = await loadDocumentTableStore();

		expect(documentTableViewStore.get()).toEqual({
			filter: "",
			sort: { column: "modified", direction: "desc" },
			groupBy: null,
			mode: "browse",
		});
	});

	it("keeps sort while the filter changes", async () => {
		const {
			documentTableViewStore,
			setDocumentTableFilter,
			toggleDocumentTableSort,
		} = await loadDocumentTableStore();

		toggleDocumentTableSort("name");
		setDocumentTableFilter("spec");

		expect(documentTableViewStore.get()).toEqual({
			filter: "spec",
			sort: { column: "name", direction: "asc" },
			groupBy: null,
			mode: "browse",
		});
	});

	it("forgets the filter, the sort, the grouping and the mode on a workspace switch", async () => {
		const {
			documentTableViewStore,
			setDocumentTableFilter,
			setDocumentTableGroupBy,
			setDocumentTableMode,
			toggleDocumentTableSort,
			workspacePathStore,
		} = await loadDocumentTableStore();

		setDocumentTableFilter("spec");
		toggleDocumentTableSort("name");
		setDocumentTableGroupBy("tag");
		setDocumentTableMode("search");
		workspacePathStore.set("/other-workspace");
		// Store notifications are delivered on a microtask.
		await new Promise((resolve) => setTimeout(resolve, 0));

		// EC-72: the view resets on a switch the way the sidebar's active page
		// did, and one store owns all four fields so none can survive alone.
		expect(documentTableViewStore.get()).toEqual({
			filter: "",
			sort: { column: "modified", direction: "desc" },
			groupBy: null,
			mode: "browse",
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
