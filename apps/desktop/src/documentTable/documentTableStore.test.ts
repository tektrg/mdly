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
		});
	});

	it("forgets the filter and the sort on a workspace switch", async () => {
		const {
			documentTableViewStore,
			setDocumentTableFilter,
			toggleDocumentTableSort,
			workspacePathStore,
		} = await loadDocumentTableStore();

		setDocumentTableFilter("spec");
		toggleDocumentTableSort("name");
		workspacePathStore.set("/other-workspace");
		// Store notifications are delivered on a microtask.
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(documentTableViewStore.get()).toEqual({
			filter: "",
			sort: { column: "modified", direction: "desc" },
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
