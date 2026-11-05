// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { folderMatchesQuery, workspaceFolderPaths } from "../documentTableView";
import { describePropertyFilter } from "./documentViews";

const addPropertyFilter = vi.fn();
const removePropertyFilter = vi.fn();
vi.mock("../documentTableStore", () => ({
	addPropertyFilter: (f: unknown) => addPropertyFilter(f),
	removePropertyFilter: (f: unknown) => removePropertyFilter(f),
	replacePropertyFilter: (a: unknown, b: unknown) => {
		removePropertyFilter(a);
		addPropertyFilter(b);
	},
	saveCurrentViewAs: vi.fn(),
	setPropertyGroupBy: vi.fn(),
}));

const { PropertyViewBar } = await import("./PropertyViewBar");

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const scan = {
	status: "idle",
	invalidPaths: [],
} as unknown as Parameters<typeof PropertyViewBar>[0]["scan"];

function view(propertyFilters: unknown[] = []) {
	return {
		propertyFilters,
		propertyGroupBy: null,
	} as unknown as Parameters<typeof PropertyViewBar>[0]["view"];
}

describe("workspaceFolderPaths", () => {
	it("lists unique folders incl. ancestors, sorted, root excluded", () => {
		expect(
			workspaceFolderPaths([
				{ folderLabel: "—" },
				{ folderLabel: "Zeta" },
				{ folderLabel: "AptusFit/sub/deep" },
				{ folderLabel: "AptusFit/sub/deep" },
			] as never),
		).toEqual(["AptusFit", "AptusFit/sub", "AptusFit/sub/deep", "Zeta"]);
	});
});

describe("folderMatchesQuery", () => {
	it("matches path-style queries per segment, in order", () => {
		expect(folderMatchesQuery("project/abc", "project/abc")).toBe(true);
		expect(folderMatchesQuery("project/abc/deep", "project/abc")).toBe(true);
		expect(folderMatchesQuery("my-project/x/abcd", "project/abc")).toBe(true);
		expect(folderMatchesQuery("Project/ABC", "project/abc")).toBe(true);
		expect(folderMatchesQuery("project/abc", "/project/abc/")).toBe(true);
		expect(folderMatchesQuery("a/project", "project/abc")).toBe(false);
		expect(folderMatchesQuery("abc/project", "project/abc")).toBe(false);
		expect(folderMatchesQuery("project", "project/abc")).toBe(false);
	});
	it("keeps plain substring behaviour", () => {
		expect(folderMatchesQuery("AptusFit/sub", "sub")).toBe(true);
		expect(folderMatchesQuery("AptusFit/sub", "")).toBe(true);
		expect(folderMatchesQuery("Notes", "sub")).toBe(false);
	});
});

describe("folder chip label", () => {
	it("reads Folder: <path>", () => {
		expect(
			describePropertyFilter({ kind: "folder", path: "AptusFit" }, []),
		).toBe("Folder: AptusFit");
	});
});

describe("+ Folder picker", () => {
	let container: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		addPropertyFilter.mockClear();
		removePropertyFilter.mockClear();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		document.body.innerHTML = "";
	});

	const folders = ["AptusFit", "AptusFit/sub", "Notes"];
	const button = (label: string) =>
		[...container.querySelectorAll("button")].find(
			(b) => b.textContent === label || b.getAttribute("aria-label") === label,
		);
	const options = () =>
		[...document.body.querySelectorAll('[role="option"]')].map(
			(o) => o.textContent,
		);

	it("adds a folder chip from the picker", () => {
		act(() =>
			root.render(
				<PropertyViewBar
					view={view()}
					fields={[]}
					scan={scan}
					folders={folders}
				/>,
			),
		);
		act(() => button("+ Folder")?.click());
		expect(options()).toEqual(folders);
		const sub =
			document.body.querySelectorAll<HTMLElement>('[role="option"]')[1];
		act(() => sub.click());
		expect(addPropertyFilter).toHaveBeenCalledWith({
			kind: "folder",
			path: "AptusFit/sub",
		});
		expect(document.body.querySelector('[role="listbox"]')).toBeNull();
	});

	it("search narrows the list", () => {
		act(() =>
			root.render(
				<PropertyViewBar
					view={view()}
					fields={[]}
					scan={scan}
					folders={folders}
				/>,
			),
		);
		act(() => button("+ Folder")?.click());
		const input = document.body.querySelector<HTMLInputElement>(
			'input[aria-label="Search folders"]',
		);
		act(() => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set?.call(input, "sub");
			input?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(options()).toEqual(["AptusFit/sub"]);
	});

	it("edits an existing chip via the same picker and removes it", () => {
		const chip = { kind: "folder", path: "AptusFit" };
		act(() =>
			root.render(
				<PropertyViewBar
					view={view([chip])}
					fields={[]}
					scan={scan}
					folders={folders}
				/>,
			),
		);
		act(() => button("Folder: AptusFit")?.click());
		const notes = [
			...document.body.querySelectorAll<HTMLElement>('[role="option"]'),
		].find((o) => o.textContent === "Notes");
		act(() => notes?.click());
		expect(removePropertyFilter).toHaveBeenCalledWith(chip);
		expect(addPropertyFilter).toHaveBeenCalledWith({
			kind: "folder",
			path: "Notes",
		});
		removePropertyFilter.mockClear();
		act(() => button("Remove filter: Folder: AptusFit")?.click());
		expect(removePropertyFilter).toHaveBeenCalledWith(chip);
	});
});
