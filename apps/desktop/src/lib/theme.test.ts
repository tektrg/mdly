// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyContrastPreference,
	applyResolvedTheme,
	readStoredContrastPreference,
	readStoredThemePreference,
	resolveThemePreference,
	syncThemePreference,
} from "./theme";

describe("theme preference", () => {
	beforeEach(() => {
		document.documentElement.className = "";
		document.documentElement.removeAttribute("style");
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
