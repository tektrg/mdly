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
});
