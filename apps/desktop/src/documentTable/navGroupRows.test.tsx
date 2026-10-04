// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceStore } from "../store/state";
import { DocumentRowList } from "./DocumentRowList";
import { beginTagScan, completeTagScan, resetTagScan } from "./tagScanStore";
import { buildRows, viewWith } from "./testFixtures";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE = "/ws";

function setWorkspace(path: string | null) {
	workspaceStore.set((state) => ({ ...state, workspacePath: path }));
}

function clearNavExpanded() {
	workspaceStore.set((state) => ({ ...state, navExpandedGroups: {} }));
}

describe("nav group rows (R2)", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		setWorkspace(null);
		clearNavExpanded();
		resetTagScan();
	});

	function renderList(view?: ReturnType<typeof viewWith>) {
		const resolved = view ?? viewWith();
		act(() => {
			root.render(
				<DocumentRowList
					rows={buildRows({ view: resolved })}
					density="table"
					view={view}
					onOpenDocument={vi.fn()}
					emptyState={<p>No documents</p>}
				/>,
			);
		});
	}

	function groupIds(): (string | null)[] {
		return Array.from(
			container.querySelectorAll<HTMLElement>("[data-group-id]"),
		).map((el) => el.getAttribute("data-group-id"));
	}

	function docNames(): (string | null)[] {
		return Array.from(
			container.querySelectorAll<HTMLElement>(
				"[data-document-row-index]:not([data-group-id])",
			),
		).map((row) => row.textContent);
	}

	it("renders flat with no view prop — no headers, same documents", () => {
		renderList();
		expect(groupIds()).toHaveLength(0);
		expect(docNames()).toHaveLength(3);
	});

	it("groups by folder with headers above their documents", () => {
		renderList(viewWith({ groupBy: "folder" }));
		expect(groupIds()).toContain("notes");
		// Root documents render after the groups, explorer-style.
		expect(docNames().some((text) => text?.includes("alpha"))).toBe(true);
		expect(docNames().some((text) => text?.includes("beta"))).toBe(true);
	});

	it("toggle collapses a group and persists it per workspace", async () => {
		setWorkspace(WORKSPACE);
		renderList(viewWith({ groupBy: "folder" }));
		const notes = container.querySelector<HTMLElement>(
			'[data-group-id="notes"]',
		);
		expect(notes).not.toBeNull();
		expect(docNames().some((text) => text?.includes("beta"))).toBe(true);

		// The store notifies subscribers on a microtask, so the collapse lands
		// after an async flush — a sync act would assert the stale tree.
		await act(async () => {
			notes?.querySelector("button")?.click();
		});
		expect(docNames().some((text) => text?.includes("beta"))).toBe(false);
		expect(
			workspaceStore.get().navExpandedGroups[WORKSPACE] ?? [],
		).not.toContain("notes");

		// A remount reads the persisted set back: still collapsed.
		act(() => root.unmount());
		root = createRoot(container);
		renderList(viewWith({ groupBy: "folder" }));
		expect(docNames().some((text) => text?.includes("beta"))).toBe(false);
	});

	it("tag mode renders Untagged last and collapsed by default", () => {
		setWorkspace(WORKSPACE);
		beginTagScan(WORKSPACE);
		completeTagScan({
			scope: WORKSPACE,
			files: [
				{ path: "/ws/alpha.md", modifiedAt: 1_700_000_300 },
				{ path: "/ws/notes/beta.markdown", modifiedAt: 1_700_000_200 },
				{ path: "/ws/notes/deep/gamma.md", modifiedAt: 1_700_000_100 },
			],
			scannedPaths: [
				"/ws/alpha.md",
				"/ws/notes/beta.markdown",
				"/ws/notes/deep/gamma.md",
			],
			tags: {
				"/ws/notes/beta.markdown": ["meeting"],
				"/ws/notes/deep/gamma.md": ["meeting/standup"],
			},
		});
		renderList(viewWith({ groupBy: "tag" }));

		const ids = groupIds();
		expect(ids).toContain("meeting");
		expect(ids[ids.length - 1]).toBe("__untagged__");
		const untagged = container.querySelector<HTMLElement>(
			'[data-group-id="__untagged__"]',
		);
		expect(
			untagged?.querySelector("button")?.getAttribute("aria-expanded"),
		).toBe("false");
		// Tagged groups arrive expanded; the untagged document stays hidden.
		expect(docNames().some((text) => text?.includes("beta"))).toBe(true);
		expect(docNames().some((text) => text?.includes("alpha"))).toBe(false);
	});

	it("headers share the list's fixed row height in both densities", () => {
		for (const density of ["table", "list"] as const) {
			const view = viewWith({ groupBy: "folder" });
			act(() => {
				root.render(
					<DocumentRowList
						rows={buildRows({ view })}
						density={density}
						view={view}
						onOpenDocument={vi.fn()}
						emptyState={<p>No documents</p>}
					/>,
				);
			});
			const expected = density === "table" ? "28px" : "62px";
			const header = container.querySelector<HTMLElement>("[data-group-id]");
			expect(header?.style.blockSize).toBe(expected);
			const doc = container.querySelector<HTMLElement>(
				"[data-document-row-index]:not([data-group-id])",
			);
			expect(doc?.style.blockSize).toBe(expected);
			act(() => root.unmount());
			root = createRoot(container);
		}
	});
});
