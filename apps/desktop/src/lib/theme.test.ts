// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyContrastPreference,
	applyEditorFontPreference,
	applyResolvedTheme,
	readStoredContrastPreference,
	readStoredEditorFontPreference,
	readStoredThemePreference,
	resolveThemePreference,
	syncThemePreference,
} from "./theme";

describe("theme preference", () => {
	beforeEach(() => {
		document.documentElement.className = "";
		document.documentElement.removeAttribute("style");
		document.documentElement.removeAttribute("data-contrast");
		document.documentElement.removeAttribute("data-editor-font");
		vi.unstubAllGlobals();
	});

	it("resolves system preference from the current OS color scheme", () => {
		expect(
			resolveThemePreference({
				preference: "system",
				systemPrefersDark: true,
			}),
		).toBe("dark");
		expect(
			resolveThemePreference({
				preference: "system",
				systemPrefersDark: false,
			}),
		).toBe("light");
		expect(
			resolveThemePreference({
				preference: "dark",
				systemPrefersDark: false,
			}),
		).toBe("dark");
	});

	it("reads only supported persisted theme preferences", () => {
		expect(
			readStoredThemePreference("hubble", {
				getItem: () => JSON.stringify({ ui: { themePreference: "dark" } }),
			}),
		).toBe("dark");
		expect(
			readStoredThemePreference("hubble", {
				getItem: () => JSON.stringify({ ui: { themePreference: "sepia" } }),
			}),
		).toBe("system");
		expect(
			readStoredThemePreference("hubble", {
				getItem: () => "{not-json",
			}),
		).toBe("system");
	});

	it("reads only supported persisted contrast preferences", () => {
		expect(
			readStoredContrastPreference("hubble", {
				getItem: () => JSON.stringify({ ui: { contrastPreference: "crisp" } }),
			}),
		).toBe("crisp");
		expect(
			readStoredContrastPreference("hubble", {
				getItem: () => JSON.stringify({ ui: { contrastPreference: "dim" } }),
			}),
		).toBe("standard");
		expect(
			readStoredContrastPreference("hubble", {
				getItem: () => "{not-json",
			}),
		).toBe("standard");
	});

	it("reads only supported persisted editor font preferences", () => {
		expect(
			readStoredEditorFontPreference("hubble", {
				getItem: () =>
					JSON.stringify({ ui: { editorFontPreference: "Avenir Next" } }),
			}),
		).toBe("Avenir Next");
		expect(
			readStoredEditorFontPreference("hubble", {
				getItem: () =>
					JSON.stringify({ ui: { editorFontPreference: "Bad\nFont" } }),
			}),
		).toBe("system");
		expect(
			readStoredEditorFontPreference("hubble", {
				getItem: () =>
					JSON.stringify({ ui: { editorFontPreference: "rounded" } }),
			}),
		).toBe("Fredoka");
		expect(
			readStoredEditorFontPreference("hubble", {
				getItem: () => "{not-json",
			}),
		).toBe("system");
	});

	it("applies the resolved theme class and native color scheme", () => {
		applyResolvedTheme("dark");
		expect(document.documentElement.classList.contains("dark")).toBe(true);
		expect(document.documentElement.style.colorScheme).toBe("dark");

		applyResolvedTheme("light");
		expect(document.documentElement.classList.contains("dark")).toBe(false);
		expect(document.documentElement.style.colorScheme).toBe("light");
	});

	it("applies the contrast preference to the root element", () => {
		applyContrastPreference("soft");
		expect(document.documentElement.dataset.contrast).toBe("soft");

		applyContrastPreference("crisp");
		expect(document.documentElement.dataset.contrast).toBe("crisp");
	});

	it("applies the editor font preference to the root element", () => {
		applyEditorFontPreference("Avenir Next");
		expect(document.documentElement.dataset.editorFont).toBe("custom");
		expect(
			document.documentElement.style.getPropertyValue("--editor-font-family"),
		).toContain('"Avenir Next"');

		applyEditorFontPreference('Quote " Font');
		expect(
			document.documentElement.style.getPropertyValue("--editor-font-family"),
		).toContain('"Quote \\" Font"');

		applyEditorFontPreference("system");
		expect(document.documentElement.dataset.editorFont).toBe("system");
		expect(
			document.documentElement.style.getPropertyValue("--editor-font-family"),
		).toBe("");
	});

	it("keeps system preference synced to OS color-scheme changes", () => {
		let matches = false;
		const listeners = new Set<() => void>();
		const addEventListener = vi.fn((_event: "change", listener: () => void) => {
			listeners.add(listener);
		});
		const removeEventListener = vi.fn(
			(_event: "change", listener: () => void) => {
				listeners.delete(listener);
			},
		);
		vi.stubGlobal("matchMedia", () => ({
			get matches() {
				return matches;
			},
			addEventListener,
			removeEventListener,
		}));

		const dispose = syncThemePreference("system");

		expect(document.documentElement.classList.contains("dark")).toBe(false);
		matches = true;
		for (const listener of listeners) listener();
		expect(document.documentElement.classList.contains("dark")).toBe(true);

		dispose();
		expect(removeEventListener).toHaveBeenCalledTimes(1);
	});
});
