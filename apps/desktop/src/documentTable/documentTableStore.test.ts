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
			propertyFilters: [],
			propertyGroupBy: null,
			activeSavedViewId: null,
			layout: { viewType: "table", boardField: null, calendarField: null },
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
			propertyFilters: [],
			propertyGroupBy: null,
			activeSavedViewId: null,
			layout: { viewType: "table", boardField: null, calendarField: null },
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
			propertyFilters: [],
			propertyGroupBy: null,
			activeSavedViewId: null,
			layout: { viewType: "table", boardField: null, calendarField: null },
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

	it("keeps unsaved chips for the session and snapshots them into a saved view", async () => {
		const {
			addPropertyFilter,
			documentTableViewStore,
			saveCurrentViewAs,
			selectSavedView,
			setPropertyGroupBy,
			togglePropertyColumn,
			workspaceStore,
			workspacePathStore,
		} = await loadDocumentTableStore();
		workspacePathStore.set("/ws");
		await new Promise((resolve) => setTimeout(resolve, 0));

		addPropertyFilter({ fieldId: "prop:due", kind: "has" });
		addPropertyFilter({ fieldId: "prop:due", kind: "has" });
		setPropertyGroupBy("prop:status");
		togglePropertyColumn("prop:status");
		expect(documentTableViewStore.get().propertyFilters).toEqual([
			{ fieldId: "prop:due", kind: "has" },
		]);
		expect(workspaceStore.get().documentViews["/ws"]?.propertyColumns).toEqual([
			"prop:status",
		]);

		const id = saveCurrentViewAs("  Due work  ");
		const saved = workspaceStore.get().documentViews["/ws"]?.saved[0];
		expect(saved).toMatchObject({
			id,
			name: "Due work",
			filters: [{ fieldId: "prop:due", kind: "has" }],
			groupBy: "prop:status",
			propertyColumns: ["prop:status"],
		});
		expect(documentTableViewStore.get().activeSavedViewId).toBe(id);

		// Edits while the saved view is shown are written into it, not the session.
		addPropertyFilter({ fieldId: "prop:status", kind: "is", value: "Done" });
		expect(
			workspaceStore.get().documentViews["/ws"]?.saved[0]?.filters,
		).toHaveLength(2);
		expect(documentTableViewStore.get().propertyFilters).toHaveLength(1);

		selectSavedView(null);
		expect(documentTableViewStore.get().activeSavedViewId).toBeNull();
	});

	it("keeps the layout per view: session for All documents, saved into a saved view", async () => {
		const {
			documentTableViewStore,
			saveCurrentViewAs,
			selectSavedView,
			setBoardField,
			setCalendarField,
			setDocumentViewType,
			workspaceStore,
			workspacePathStore,
		} = await loadDocumentTableStore();
		workspacePathStore.set("/ws");
		await new Promise((resolve) => setTimeout(resolve, 0));

		setDocumentViewType("board");
		setBoardField("prop:stage");
		expect(documentTableViewStore.get().layout).toEqual({
			viewType: "board",
			boardField: "prop:stage",
			calendarField: null,
		});

		const id = saveCurrentViewAs("Pipeline");
		expect(workspaceStore.get().documentViews["/ws"]?.saved[0]).toMatchObject({
			id,
			viewType: "board",
			boardField: "prop:stage",
			calendarField: null,
		});

		setDocumentViewType("calendar");
		setCalendarField("prop:start");
		expect(workspaceStore.get().documentViews["/ws"]?.saved[0]).toMatchObject({
			viewType: "calendar",
			calendarField: "prop:start",
		});
		// The unsaved view's own layout is untouched by edits to the saved one.
		expect(documentTableViewStore.get().layout.viewType).toBe("board");
		selectSavedView(null);
		expect(documentTableViewStore.get().layout.viewType).toBe("board");
	});

	it("routes a header sort into the active saved view and drops a deleted view", async () => {
		const {
			deleteSavedView,
			documentTableViewStore,
			saveCurrentViewAs,
			toggleDocumentTableSort,
			workspaceStore,
			workspacePathStore,
		} = await loadDocumentTableStore();
		workspacePathStore.set("/ws");
		await new Promise((resolve) => setTimeout(resolve, 0));

		const id = saveCurrentViewAs("Mine") as string;
		toggleDocumentTableSort("prop:priority");
		expect(workspaceStore.get().documentViews["/ws"]?.saved[0]?.sort).toEqual({
			column: "prop:priority",
			direction: "asc",
		});
		expect(workspaceStore.get().navViewSorts["/ws"]).toBeUndefined();

		deleteSavedView(id);
		expect(workspaceStore.get().documentViews["/ws"]?.saved).toEqual([]);
		expect(documentTableViewStore.get().activeSavedViewId).toBeNull();
	});

	it("leaves the saved view and the property grouping when a folder/tag view is picked", async () => {
		const {
			documentTableViewStore,
			saveCurrentViewAs,
			setDocumentTableGroupBy,
			setPropertyGroupBy,
			workspacePathStore,
		} = await loadDocumentTableStore();
		workspacePathStore.set("/ws");
		await new Promise((resolve) => setTimeout(resolve, 0));

		setPropertyGroupBy("prop:status");
		saveCurrentViewAs("Board");
		setDocumentTableGroupBy("folder");
		expect(documentTableViewStore.get()).toMatchObject({
			groupBy: "folder",
			propertyGroupBy: null,
			activeSavedViewId: null,
			layout: { viewType: "table", boardField: null, calendarField: null },
		});
	});
});
