// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workspacePathStore, workspaceStore } from "../../store/state";
import { DocumentTable } from "../DocumentTable";
import {
	applyDocumentTableView,
	buildDocumentRows,
	type DocumentTableView,
	resetDocumentRowsMemo,
	withPropertyValues,
} from "../documentTableView";
import { viewWith } from "../testFixtures";
import { derivePropertyModel, type PropertiesByPath } from "./propertyFields";
import { propertyScanStore, resetPropertyScan } from "./propertyScanStore";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROPERTIES: PropertiesByPath = {
	"/ws/a.md": { status: { type: "text", value: "Todo" } },
	"/ws/b.md": { status: { type: "text", value: "Done" } },
	"/ws/c.md": { status: { type: "text", value: "Todo" } },
};
const FILES = ["/ws/a.md", "/ws/b.md", "/ws/c.md", "/ws/d.md"].map(
	(path, index) => ({ path, modified_at: 100 + index }),
);

describe("DocumentTable with property columns", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		resetDocumentRowsMemo();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		workspacePathStore.set("/ws");
		workspaceStore.set((state) => ({
			...state,
			workspacePath: "/ws",
			documentViews: { "/ws": { propertyColumns: ["prop:status"], saved: [] } },
		}));
		propertyScanStore.set({
			...propertyScanStore.get(),
			scope: "/ws",
			status: "ready",
			propertiesByPath: PROPERTIES,
			invalidPaths: ["/ws/broken.md"],
		});
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		resetPropertyScan();
	});

	function render(view: DocumentTableView) {
		const model = derivePropertyModel(PROPERTIES);
		const rows = applyDocumentTableView(
			withPropertyValues(buildDocumentRows(FILES, "/ws"), model.valuesByPath),
			view,
			null,
			model.fields,
		);
		act(() => {
			root.render(
				<DocumentTable
					rows={rows}
					view={view}
					listing={{ kind: "listed" }}
					onOpenDocument={() => {}}
					onFilterChange={() => {}}
					onToggleSort={() => {}}
					onRetryListing={() => {}}
				/>,
			);
		});
	}

	it("renders the property column, its cells, the chip and the unreadable-file notice", () => {
		render(
			viewWith({ propertyFilters: [{ fieldId: "prop:status", kind: "has" }] }),
		);
		const headers = [
			...container.querySelectorAll('[role="columnheader"]'),
		].map((header) => header.textContent ?? "");
		// Title Case for display; the field id stays `prop:status`.
		expect(headers.some((text) => text.includes("Status"))).toBe(true);
		expect(headers.some((text) => text.includes("NAME"))).toBe(false);
		const cells = [
			...container.querySelectorAll("[data-property-cell='prop:status']"),
		].map((cell) => cell.textContent);
		expect(cells.sort()).toEqual(["Done", "Todo", "Todo"]);
		expect(container.textContent).toContain("has status");
		expect(container.textContent).toContain(
			"1 file has unreadable front matter",
		);
		// The settled warning is a "⚠ 1" pill whose tooltip carries the sentence.
		const badge = container.querySelector("[data-scan-badge]");
		expect(badge?.textContent).toContain("⚠ 1");
		expect(badge?.getAttribute("title")).toContain(
			"1 file has unreadable front matter",
		);
		expect(container.querySelector('[data-save-view="save"]')).not.toBeNull();
		expect(
			container.querySelector('button[aria-label="More view options"]'),
		).not.toBeNull();
		// The header "+" has its own cell beside the column row, never inside it.
		const addCell = container.querySelector("[data-header-add-cell]");
		expect(
			addCell?.querySelector('button[aria-label="Add property"]'),
		).not.toBeNull();
		expect(addCell?.closest('[role="row"]')).toBeNull();
		expect(
			container
				.querySelector("[data-document-table-header]")
				?.closest("section")?.className,
		).toContain("bg-background");
	});

	it("groups rows under property value headers, the empty group last", () => {
		render(viewWith({ propertyGroupBy: "prop:status" }));
		const text = container.textContent ?? "";
		expect(text).toContain("Grouped by status");
		const done = text.indexOf("Done");
		const todo = text.indexOf("Todo", done);
		const none = text.indexOf("No status");
		expect(done).toBeGreaterThan(-1);
		expect(todo).toBeGreaterThan(done);
		expect(none).toBeGreaterThan(todo);
	});
});
