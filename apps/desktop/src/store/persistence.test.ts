// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { getInitialState } from "./persistence";
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

	it("hydrates git status indicators as disabled unless explicitly enabled", () => {
		vi.stubGlobal("localStorage", {
			getItem: (key: string) =>
				key === STORAGE_KEY
					? JSON.stringify({ ui: { showGitStatusIndicators: true } })
					: null,
		});

		expect(getInitialState().ui.showGitStatusIndicators).toBe(true);
	});
});
