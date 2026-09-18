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

describe("tag scan view (A9)", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		resetTagScan();
		setWorkspace(WORKSPACE);
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
		// The store notifies on a microtask, so the entering-scan effect and
		// the progress paint land after an async flush.
		await act(async () => {
			root.render(
				<DocumentRowList
					rows={buildRows({ view })}
					density="table"
					sortColumn={view.sort.column}
					view={view}
					onOpenDocument={vi.fn()}
					emptyState={<p>No documents</p>}
				/>,
			);
		});
	}

	it("triggers a scan on entering tag mode and shows progress, zero groups", async () => {
		expect(tagScanStore.get()).toEqual({ kind: "idle" });
		await renderTagList();

		expect(tagScanStore.get()).toEqual({
			kind: "scanning",
			scope: WORKSPACE,
		});
		expect(
			container.querySelector('[data-tag-scan-state="scanning"]')?.textContent,
		).toContain("Reading tags");
		expect(container.querySelectorAll("[data-group-id]")).toHaveLength(0);
	});

	it("shows the failed shape with retry and no Untagged group", async () => {
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
		expect(tagScanStore.get()).toEqual({
			kind: "scanning",
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
					sortColumn={view.sort.column}
					view={view}
					onOpenDocument={vi.fn()}
					emptyState={<p>No documents</p>}
				/>,
			);
		});

		expect(tagScanStore.get()).toEqual({ kind: "idle" });
	});
});
