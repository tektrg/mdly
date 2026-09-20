// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
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

	it("hydrates a fresh session onto the document table with the sidebar preference intact", () => {
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
		expect(state.ui.sidebarOpen).toBe(true);
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
});
