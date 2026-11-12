// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspacePathStore } from "../store/state";
import { DocumentTable } from "./DocumentTable";
import type { DocumentListingState } from "./documentListingState";
import { resetDocumentTableLayoutForTests } from "./documentTableLayout";
import {
	getCurrentPropertyColumns,
	togglePropertyColumn,
} from "./documentTableStore";
import type { DocumentTableRow } from "./documentTableView";
import { buildRows, viewWith } from "./testFixtures";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LISTED: DocumentListingState = { kind: "listed" };

function dragData() {
	const store: Record<string, string> = {};
	return {
		effectAllowed: "none",
		dropEffect: "none",
		setData: (key: string, value: string) => {
			store[key] = value;
		},
		getData: (key: string) => store[key] ?? "",
	};
}

function fireDrag(
	target: Element,
	type: "dragstart" | "dragover" | "drop" | "dragend",
	dataTransfer: ReturnType<typeof dragData>,
) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	(event as Event & { dataTransfer?: unknown }).dataTransfer = dataTransfer;
	act(() => {
		target.dispatchEvent(event);
	});
	return event;
}

function headerCells(container: HTMLElement) {
	return Array.from(
		container.querySelectorAll<HTMLElement>('[role="columnheader"]'),
	);
}

function headerLabels(container: HTMLElement) {
	return headerCells(container).map(
		(cell) => cell.querySelector("button")?.textContent,
	);
}

describe("DocumentTable column reorder", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		localStorage.clear();
		resetDocumentTableLayoutForTests();
		act(() => {
			root.render(
				<DocumentTable
					rows={buildRows() as DocumentTableRow[]}
					view={viewWith()}
					listing={LISTED}
					onOpenDocument={vi.fn()}
					onFilterChange={vi.fn()}
					onToggleSort={vi.fn()}
					onRetryListing={vi.fn()}
				/>,
			);
		});
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it("drops Folder onto Modified and persists the swapped order", () => {
		expect(headerLabels(container)).toEqual([
			"Name",
			"⠿Folder",
			"⠿Modified",
			"⠿Created",
		]);

		const dataTransfer = dragData();
		const cells = headerCells(container);
		const folder = cells[1];
		const modified = cells[2];

		fireDrag(folder, "dragstart", dataTransfer);
		const over = fireDrag(modified, "dragover", dataTransfer);
		// Without this the browser snap-backs the drag: drop never fires.
		expect(over.defaultPrevented).toBe(true);
		fireDrag(modified, "drop", dataTransfer);

		expect(headerLabels(container)).toEqual([
			"Name",
			"⠿Modified",
			"⠿Folder",
			"⠿Created",
		]);
		expect(
			JSON.parse(localStorage.getItem("mdly-doc-table-column-order") ?? "[]"),
		).toEqual(["name", "modified", "folder", "created"]);
	});

	it("pins Name: it is not draggable and accepts no drops", () => {
		const dataTransfer = dragData();
		const cells = headerCells(container);
		const name = cells[0];
		const folder = cells[1];

		expect(name?.getAttribute("draggable")).toBe("false");
		fireDrag(folder, "dragstart", dataTransfer);
		const over = fireDrag(name, "dragover", dataTransfer);
		expect(over.defaultPrevented).toBe(false);
		expect(headerLabels(container)).toEqual([
			"Name",
			"⠿Folder",
			"⠿Modified",
			"⠿Created",
		]);
	});

	it("moves a column with Alt+Arrow on its focused sort button", () => {
		const [, folder] = headerCells(container);
		const sortButton = folder?.querySelector("button");
		act(() => {
			sortButton?.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "ArrowRight",
					altKey: true,
					bubbles: true,
					cancelable: true,
				}),
			);
		});
		expect(headerLabels(container)).toEqual([
			"Name",
			"⠿Modified",
			"⠿Folder",
			"⠿Created",
		]);
	});
});

describe("DocumentTable property column reorder", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(async () => {
		localStorage.clear();
		resetDocumentTableLayoutForTests();
		workspacePathStore.set("/ws-reorder");
		await new Promise((resolve) => setTimeout(resolve, 0));
		togglePropertyColumn("prop:status");
		togglePropertyColumn("prop:due");
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		act(() => {
			root.render(
				<DocumentTable
					rows={buildRows() as DocumentTableRow[]}
					view={viewWith()}
					listing={LISTED}
					onOpenDocument={vi.fn()}
					onFilterChange={vi.fn()}
					onToggleSort={vi.fn()}
					onRetryListing={vi.fn()}
				/>,
			);
		});
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		for (const id of getCurrentPropertyColumns()) togglePropertyColumn(id);
	});

	it("drags a newly added property column onto another one", () => {
		const cells = headerCells(container);
		const status = cells[4];
		const due = cells[5];
		expect(status?.getAttribute("draggable")).toBe("true");

		const dataTransfer = dragData();
		fireDrag(due, "dragstart", dataTransfer);
		const over = fireDrag(status, "dragover", dataTransfer);
		expect(over.defaultPrevented).toBe(true);
		fireDrag(status, "drop", dataTransfer);

		expect(getCurrentPropertyColumns()).toEqual(["prop:due", "prop:status"]);
		// Built-in columns are untouched by a property drag.
		expect(headerLabels(container).slice(0, 4)).toEqual([
			"Name",
			"⠿Folder",
			"⠿Modified",
			"⠿Created",
		]);
	});

	it("ignores a built-in column dropped onto a property column", () => {
		const cells = headerCells(container);
		const dataTransfer = dragData();
		fireDrag(cells[1], "dragstart", dataTransfer);
		const over = fireDrag(cells[4], "dragover", dataTransfer);
		expect(over.defaultPrevented).toBe(false);
		expect(getCurrentPropertyColumns()).toEqual(["prop:status", "prop:due"]);
	});
});
