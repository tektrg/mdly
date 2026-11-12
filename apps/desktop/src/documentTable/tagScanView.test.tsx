// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceStore } from "../store/state";
import { DocumentRowList } from "./DocumentRowList";
import {
	beginTagScan,
	failTagScan,
	resetTagScan,
	tagScanStore,
} from "./tagScanStore";
import { buildRows, viewWith, WORKSPACE_FILES } from "./testFixtures";

const scanFrontMatterTags = vi.hoisted(() => vi.fn());

vi.mock("../desktopApi", () => ({
	desktopApi: { scanFrontMatterTags },
}));

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

describe("tag scan view (A9)", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		resetTagScan();
		scanFrontMatterTags.mockReset();
		scanFrontMatterTags.mockResolvedValue({});
		workspaceStore.set((state) => ({
			...state,
			workspacePath: WORKSPACE,
			files: WORKSPACE_FILES,
		}));
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		setWorkspace(null);
		clearNavExpanded();
		resetTagScan();
	});

	async function renderTagList() {
		const view = viewWith({ groupBy: "tag" });
		// The store notifies on a microtask, so the scan effect and its result
		// land after an async flush.
		await act(async () => {
			root.render(
				<DocumentRowList
					rows={buildRows({ view })}
					density="table"
					view={view}
					onOpenDocument={vi.fn()}
					emptyState={<p>No documents</p>}
				/>,
			);
		});
	}

	it("reads the workspace's markdown files on entering tag mode", async () => {
		scanFrontMatterTags.mockReturnValue(new Promise(() => {}));
		expect(tagScanStore.get()).toEqual({ kind: "idle" });

		await renderTagList();

		expect(scanFrontMatterTags).toHaveBeenCalledTimes(1);
		const scanned = scanFrontMatterTags.mock.calls[0]?.[0] as string[];
		expect(scanned).toEqual([
			"/ws/alpha.md",
			"/ws/notes/beta.markdown",
			"/ws/notes/deep/gamma.md",
		]);
		expect(tagScanStore.get()).toEqual({ kind: "scanning", scope: WORKSPACE });
		expect(
			container.querySelector('[data-tag-scan-state="scanning"]')?.textContent,
		).toContain("Reading tags");
		expect(container.querySelectorAll("[data-group-id]")).toHaveLength(0);
	});

	it("completes the scan and groups documents by their front-matter tags", async () => {
		scanFrontMatterTags.mockResolvedValue({
			"/ws/alpha.md": ["idea"],
			"/ws/notes/beta.markdown": ["idea", "meeting"],
		});

		await renderTagList();
		await act(async () => {});

		expect(tagScanStore.get()).toMatchObject({
			kind: "scanned",
			scope: WORKSPACE,
			tagsByPath: {
				"/ws/alpha.md": ["idea"],
				"/ws/notes/beta.markdown": ["idea", "meeting"],
			},
		});
		// The scan resolves, so the list renders real tag groups — never the
		// "Reading tags…" pending row it would be stuck on without a reader.
		expect(
			container.querySelector('[data-tag-scan-state="scanning"]'),
		).toBeNull();
		expect(container.querySelector('[data-group-id="idea"]')).not.toBeNull();
	});

	it("shows the failed shape when the scan rejects", async () => {
		scanFrontMatterTags.mockRejectedValue(new Error("EACCES"));

		await renderTagList();
		await act(async () => {});

		expect(tagScanStore.get()).toMatchObject({
			kind: "failed",
			scope: WORKSPACE,
			message: "EACCES",
		});
		expect(
			container.querySelector('[data-tag-scan-state="failed"]')?.textContent,
		).toContain("Try again");
	});

	it("shows the failed shape with retry, and a retry re-runs the scan", async () => {
		beginTagScan(WORKSPACE);
		failTagScan(WORKSPACE, "EACCES");
		await renderTagList();

		const failed = container.querySelector('[data-tag-scan-state="failed"]');
		expect(failed).not.toBeNull();
		expect(failed?.textContent).toContain("Try again");
		expect(container.querySelectorAll("[data-group-id]")).toHaveLength(0);

		await act(async () => {
			failed
				?.querySelector("button")
				?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		await act(async () => {});

		expect(scanFrontMatterTags).toHaveBeenCalledTimes(1);
		expect(tagScanStore.get()).toMatchObject({
			kind: "scanned",
			scope: WORKSPACE,
		});
	});

	it("does not trigger a scan outside tag mode", async () => {
		const view = viewWith({ groupBy: "folder" });
		await act(async () => {
			root.render(
				<DocumentRowList
					rows={buildRows({ view })}
					density="table"
					view={view}
					onOpenDocument={vi.fn()}
					emptyState={<p>No documents</p>}
				/>,
			);
		});

		expect(scanFrontMatterTags).not.toHaveBeenCalled();
		expect(tagScanStore.get()).toEqual({ kind: "idle" });
	});

	describe("saved view grouped by Tag", () => {
		async function renderTagGroupedView() {
			const view = viewWith({ propertyGroupBy: "group:tag" });
			await act(async () => {
				root.render(
					<DocumentRowList
						rows={buildRows({ view })}
						density="table"
						view={view}
						onOpenDocument={vi.fn()}
						emptyState={<p>No documents</p>}
					/>,
				);
			});
		}

		it("shows Scanning tags… instead of an all-Other list while the scan runs", async () => {
			scanFrontMatterTags.mockReturnValue(new Promise(() => {}));

			await renderTagGroupedView();

			// The grouping itself starts the same scan the nav Tag view uses.
			expect(scanFrontMatterTags).toHaveBeenCalledTimes(1);
			expect(
				container.querySelector('[data-tag-scan-state="scanning"]')
					?.textContent,
			).toContain("Scanning tags");
			expect(container.querySelectorAll("[data-group-id]")).toHaveLength(0);
			expect(container.textContent).not.toContain("Other");
		});

		it("renders the tag groups once the scan completes", async () => {
			scanFrontMatterTags.mockResolvedValue({
				"/ws/alpha.md": ["idea"],
			});

			await renderTagGroupedView();
			await act(async () => {});

			expect(
				container.querySelector('[data-tag-scan-state="scanning"]'),
			).toBeNull();
			expect(
				container.querySelector('[data-group-id="group:tag::idea"]'),
			).not.toBeNull();
			expect(
				container.querySelector('[data-group-id="group:tag::(other)"]'),
			).not.toBeNull();
		});
	});
});
