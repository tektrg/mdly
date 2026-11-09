// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BOARD_VIEW_SETTINGS } from "../documentTable/properties/documentViews";
import { getInitialState, serialize } from "./persistence";
import { STORAGE_KEY } from "./storage";

describe("desktop state persistence", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("hydrates migrated editor font preferences as normalized values", () => {
		vi.stubGlobal("localStorage", {
			getItem: (key: string) =>
				key === STORAGE_KEY
					? JSON.stringify({ ui: { editorFontPreference: "rounded" } })
					: null,
		});

		expect(getInitialState().ui.editorFontPreference).toBe("Fredoka");
	});

	it("hydrates the ignored-files sidebar preference when explicitly enabled", () => {
		vi.stubGlobal("localStorage", {
			getItem: (key: string) =>
				key === STORAGE_KEY
					? JSON.stringify({ ui: { showIgnoredWorkspaceFiles: true } })
					: null,
		});

		expect(getInitialState().ui.showIgnoredWorkspaceFiles).toBe(true);
	});

	it("never serializes the runtime-only document-table fields", () => {
		vi.stubGlobal("localStorage", { getItem: () => null });
		const state = getInitialState();
		state.document.requestedPath = "/ws/open.md";
		state.ui.sidebarAutoCollapsed = true;
		state.workspace.hasListedOnce = true;
		state.workspace.listingError = "EACCES";

		const snapshot = JSON.stringify(serialize(state));

		expect(snapshot).not.toContain("requestedPath");
		expect(snapshot).not.toContain("/ws/open.md");
		expect(snapshot).not.toContain("sidebarAutoCollapsed");
		expect(snapshot).not.toContain("hasListedOnce");
		expect(snapshot).not.toContain("listingError");
		expect(snapshot).not.toContain("filter");
	});

	it("hydrates a fresh session onto the document table with the sidebar hidden", () => {
		vi.stubGlobal("localStorage", {
			getItem: (key: string) =>
				key === STORAGE_KEY
					? JSON.stringify({
							document: { lastOpenedPath: "/ws/a.md" },
							ui: { sidebarOpen: true },
						})
					: null,
		});

		const state = getInitialState();

		expect(state.document.requestedPath).toBeNull();
		expect(state.document.currentPath).toBeNull();
		expect(state.document.lastOpenedPath).toBe("/ws/a.md");
		// A previously saved open sidebar is deliberately not restored.
		expect(state.ui.sidebarOpen).toBe(false);
		expect(state.ui.sidebarAutoCollapsed).toBe(false);
		expect(state.workspace.hasListedOnce).toBe(false);
		expect(state.workspace.listingError).toBeNull();
	});

	it("round-trips per-view sorts through serialize and hydrate", () => {
		vi.stubGlobal("localStorage", { getItem: () => null });
		const state = getInitialState();
		expect(state.workspace.navViewSorts).toEqual({});
		state.workspace.navViewSorts = {
			"/ws": {
				tag: { column: "name", direction: "asc" },
				recent: { column: "folder", direction: "desc" },
			},
		};

		const snapshot = JSON.stringify(serialize(state));
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => (key === STORAGE_KEY ? snapshot : null),
		});

		expect(getInitialState().workspace.navViewSorts).toEqual({
			"/ws": {
				tag: { column: "name", direction: "asc" },
				recent: { column: "folder", direction: "desc" },
			},
		});
	});

	it("drops garbage from persisted view sorts", () => {
		vi.stubGlobal("localStorage", {
			getItem: (key: string) =>
				key === STORAGE_KEY
					? JSON.stringify({
							workspace: {
								navViewSorts: {
									"/ok": {
										folder: { column: "modified", direction: "asc", extra: 1 },
										tag: { column: "size", direction: "asc" },
										recent: { column: "name", direction: "sideways" },
										bogus: { column: "name", direction: "asc" },
									},
									"/all-bad": { tag: "name", recent: null },
									"/not-a-map": "x",
									"/array": [{ column: "name", direction: "asc" }],
								},
							},
						})
					: null,
		});

		expect(getInitialState().workspace.navViewSorts).toEqual({
			"/ok": { folder: { column: "modified", direction: "asc" } },
		});
	});

	it("keeps the remembered workspace on disk when a single-file window persists", () => {
		vi.stubGlobal("localStorage", {
			getItem: (key: string) =>
				key === STORAGE_KEY
					? JSON.stringify({
							workspace: {
								workspacePath: "/ws",
								recentWorkspaces: ["/ws"],
								lastOpenedPaths: { "/ws": "/ws/a.md" },
							},
							document: { lastOpenedPath: "/ws/a.md" },
						})
					: null,
		});
		const state = getInitialState();
		// A single-file window holds an emptied workspace in memory.
		state.ui.singleFileWindow = true;
		state.workspace.workspacePath = null;
		state.workspace.recentWorkspaces = [];
		state.document.lastOpenedPath = "/outside/note.md";

		const snapshot = serialize(state);

		expect(snapshot.workspace?.workspacePath).toBe("/ws");
		expect(snapshot.workspace?.recentWorkspaces).toEqual(["/ws"]);
		expect(snapshot.workspace?.lastOpenedPaths).toEqual({
			"/ws": "/ws/a.md",
		});
		expect(snapshot.document?.lastOpenedPath).toBe("/ws/a.md");
		expect(JSON.stringify(snapshot)).not.toContain("singleFileWindow");
	});

	it("ignores a __proto__ workspace key in persisted view sorts", () => {
		vi.stubGlobal("localStorage", {
			getItem: (key: string) =>
				key === STORAGE_KEY
					? `{"workspace":{"navViewSorts":{"__proto__":{"tag":{"column":"name","direction":"asc"}},"/ws":{"tag":{"column":"name","direction":"asc"}}}}}`
					: null,
		});

		const sorts = getInitialState().workspace.navViewSorts;

		expect(Object.keys(sorts)).toEqual(["/ws"]);
		expect(Object.getPrototypeOf(sorts)).toBe(Object.prototype);
		expect(({} as Record<string, unknown>).tag).toBeUndefined();
	});

	it("round-trips saved views and property columns, dropping malformed entries", () => {
		vi.stubGlobal("localStorage", {
			getItem: (key: string) =>
				key === STORAGE_KEY
					? JSON.stringify({
							workspace: {
								navViewSorts: {
									"/ws": { recent: { column: "prop:due", direction: "desc" } },
								},
								documentViews: {
									"/ws": {
										propertyColumns: ["prop:status", "name", "prop:status"],
										saved: [
											{
												id: "v1",
												name: "  Board ",
												sort: { column: "prop:priority", direction: "asc" },
												filters: [
													{ fieldId: "prop:due", kind: "has" },
													{ fieldId: "prop:status", kind: "is", value: "Done" },
													{ fieldId: "status", kind: "has" },
													{ fieldId: "prop:x", kind: "is", value: { a: 1 } },
												],
												groupBy: "prop:status",
												propertyColumns: ["prop:status"],
											},
											{ id: "v1", name: "duplicate id" },
											{ id: "v2", name: "   " },
											"garbage",
										],
									},
									"/empty": { saved: [], propertyColumns: [] },
								},
							},
						})
					: null,
		});
		const state = getInitialState();
		expect(state.workspace.navViewSorts["/ws"]?.recent).toEqual({
			column: "prop:due",
			direction: "desc",
		});
		expect(state.workspace.documentViews).toEqual({
			"/ws": {
				propertyColumns: ["prop:status"],
				saved: [
					{
						id: "v1",
						name: "Board",
						sort: { column: "prop:priority", direction: "asc" },
						filters: [
							{ fieldId: "prop:due", kind: "has" },
							{ fieldId: "prop:status", kind: "is", value: "Done" },
						],
						groupBy: "prop:status",
						propertyColumns: ["prop:status"],
						// Views saved before board/calendar existed read as tables.
						viewType: "table",
						boardField: null,
						calendarField: null,
						board: DEFAULT_BOARD_VIEW_SETTINGS,
					},
				],
			},
		});
		expect(serialize(state).workspace?.documentViews).toEqual(
			state.workspace.documentViews,
		);
	});
});
