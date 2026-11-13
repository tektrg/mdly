// @vitest-environment happy-dom
import fs from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceStore } from "../store/state";
import { saveCurrentViewAs, setSavedViewIcon } from "./documentTableStore";
import {
	getSavedViews,
	loadWorkspaceSavedViews,
	setViewStoreFactoryForTest,
} from "./documentViewsFileStore";
import { NavEntryIcon } from "./NavViewIcon";
import { savedEntries } from "./navSwitcherEntries";
import {
	sanitizeSavedView,
	savedViewToRecord,
} from "./properties/documentViews";
import { SavedViewIconGlyph } from "./SavedViewIconGlyph";
import { IconGrid } from "./SavedViewIconPicker";
import {
	DEFAULT_SAVED_VIEW_ICON,
	filterSavedViewIcons,
	resolveSavedViewIcon,
	SAVED_VIEW_ICON_NAMES,
} from "./savedViewIcons";
import { createLocalStorageViewStore } from "./viewStores";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const glyph = (icon?: string) =>
	renderToStaticMarkup(<SavedViewIconGlyph icon={icon} />);

describe("saved view icon set", () => {
	it("is a curated set of 60–100 unique names with the default in it", () => {
		expect(SAVED_VIEW_ICON_NAMES.length).toBeGreaterThanOrEqual(60);
		expect(SAVED_VIEW_ICON_NAMES.length).toBeLessThanOrEqual(100);
		expect(new Set(SAVED_VIEW_ICON_NAMES).size).toBe(
			SAVED_VIEW_ICON_NAMES.length,
		);
		expect(SAVED_VIEW_ICON_NAMES).toContain(DEFAULT_SAVED_VIEW_ICON);
	});

	it("matches the CLI's list exactly (parity)", () => {
		const cli = fs.readFileSync(
			path.resolve(__dirname, "../../../../packages/cli/src/viewIcons.ts"),
			"utf8",
		);
		const names = [...cli.matchAll(/^\t"([^"]+)",$/gm)].map((m) => m[1]);
		expect(names).toEqual([...SAVED_VIEW_ICON_NAMES]);
	});

	it("search filters by name and keywords", () => {
		expect(filterSavedViewIcons("").length).toBe(SAVED_VIEW_ICON_NAMES.length);
		expect(filterSavedViewIcons("bolt").map((i) => i.name)).toEqual(["flash"]);
		expect(filterSavedViewIcons("zzz")).toEqual([]);
	});
});

describe("storage", () => {
	it("round-trips icon as a top-level key; no icon writes no key", () => {
		const view = sanitizeSavedView({ id: "v", name: "V", icon: "star" });
		expect(view?.icon).toBe("star");
		if (!view) throw new Error("sanitize");
		const record = JSON.parse(JSON.stringify(savedViewToRecord(view)));
		expect(record.icon).toBe("star");
		expect(sanitizeSavedView(record)).toEqual(view);
		const { icon: _drop, ...plain } = view;
		expect(
			JSON.parse(JSON.stringify(savedViewToRecord(plain))),
		).not.toHaveProperty("icon");
	});

	it("keeps an unknown (newer) name but draws the default", () => {
		const view = sanitizeSavedView({ id: "v", name: "V", icon: "future-icon" });
		expect(view?.icon).toBe("future-icon");
		expect(resolveSavedViewIcon("future-icon")).toBe(DEFAULT_SAVED_VIEW_ICON);
		expect(resolveSavedViewIcon(42)).toBe(DEFAULT_SAVED_VIEW_ICON);
		expect(
			sanitizeSavedView({ id: "v", name: "V", icon: 42 })?.icon,
		).toBeUndefined();
		expect(glyph("future-icon")).toBe(glyph(DEFAULT_SAVED_VIEW_ICON));
		expect(glyph("star")).not.toBe(glyph(DEFAULT_SAVED_VIEW_ICON));
	});

	it("the switcher entry draws the stored icon", () => {
		const view = sanitizeSavedView({ id: "v", name: "V", icon: "star" });
		if (!view) throw new Error("sanitize");
		const [entry] = savedEntries([view]);
		if (!entry) throw new Error("entry");
		expect(renderToStaticMarkup(<NavEntryIcon entry={entry} />)).toBe(
			glyph("star"),
		);
	});
});

describe("setSavedViewIcon", () => {
	const WS = "/ws-icon-set";
	let map: Map<string, string>;
	beforeEach(async () => {
		map = new Map();
		setViewStoreFactoryForTest((ws) =>
			createLocalStorageViewStore(
				{
					getItem: (k) => map.get(k) ?? null,
					setItem: (k, v) => void map.set(k, v),
				},
				ws,
			),
		);
		workspaceStore.set((s) => ({ ...s, workspacePath: WS }));
		await loadWorkspaceSavedViews(WS);
	});
	afterEach(() => {
		workspaceStore.set((s) => ({ ...s, workspacePath: null }));
		setViewStoreFactoryForTest(null);
	});

	it("sets, refuses unknown names, and resets to default", () => {
		const id = saveCurrentViewAs("Mine");
		if (!id) throw new Error("save");
		expect(setSavedViewIcon(id, "rocket")).toBe(true);
		expect(getSavedViews(WS)[0]?.icon).toBe("rocket");
		expect(setSavedViewIcon(id, "unicorn")).toBe(false);
		expect(getSavedViews(WS)[0]?.icon).toBe("rocket");
		expect(setSavedViewIcon(id, null)).toBe(true);
		expect(getSavedViews(WS)[0]).not.toHaveProperty("icon");
	});
});

describe("icon picker", () => {
	let container: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		document.body.innerHTML = "";
	});

	const render = (current: string | undefined) => {
		const onSelect = vi.fn();
		act(() => root.render(<IconGrid current={current} onSelect={onSelect} />));
		const input = container.querySelector("input") as HTMLInputElement;
		return { onSelect, input };
	};
	const key = (input: HTMLInputElement, k: string) =>
		act(() => {
			input.dispatchEvent(
				new KeyboardEvent("keydown", { key: k, bubbles: true }),
			);
		});
	const activeName = () =>
		container.querySelector("[data-active]")?.getAttribute("data-icon-option");

	it("click selects an icon; current one is marked selected", () => {
		const { onSelect } = render("star");
		expect(
			container
				.querySelector('[aria-selected="true"]')
				?.getAttribute("data-icon-option"),
		).toBe("star");
		act(() =>
			(
				container.querySelector('[data-icon-option="rocket"]') as HTMLElement
			).click(),
		);
		expect(onSelect).toHaveBeenCalledWith("rocket");
	});

	it("arrows move the highlight and Enter picks it", () => {
		const { onSelect, input } = render(undefined);
		expect(activeName()).toBe(SAVED_VIEW_ICON_NAMES[0]);
		key(input, "ArrowRight");
		expect(activeName()).toBe(SAVED_VIEW_ICON_NAMES[1]);
		key(input, "ArrowDown");
		expect(activeName()).toBe(SAVED_VIEW_ICON_NAMES[9]);
		key(input, "ArrowUp");
		key(input, "ArrowLeft");
		key(input, "ArrowLeft");
		expect(activeName()).toBe(SAVED_VIEW_ICON_NAMES[0]);
		key(input, "ArrowRight");
		key(input, "Enter");
		expect(onSelect).toHaveBeenCalledWith(SAVED_VIEW_ICON_NAMES[1]);
	});

	it("search narrows the grid and Enter picks the first match", () => {
		const { onSelect, input } = render(undefined);
		act(() => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set;
			setter?.call(input, "travel");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const shown = [...container.querySelectorAll("[data-icon-option]")].map(
			(el) => el.getAttribute("data-icon-option"),
		);
		expect(shown).toEqual(["airplane"]);
		key(input, "Enter");
		expect(onSelect).toHaveBeenCalledWith("airplane");
	});

	it("Reset to default selects null; disabled when already default", () => {
		const { onSelect } = render("star");
		const reset = container.querySelector(
			"[data-icon-reset]",
		) as HTMLButtonElement;
		expect(reset.disabled).toBe(false);
		act(() => reset.click());
		expect(onSelect).toHaveBeenCalledWith(null);
		render(undefined);
		expect(
			(container.querySelector("[data-icon-reset]") as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});
});
