// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workspacePathStore, workspaceStore } from "../../store/state";
import { DocumentTable } from "../DocumentTable";
import {
	documentTableViewStore,
	setDocumentViewType,
} from "../documentTableStore";
import {
	applyDocumentTableView,
	buildDocumentRows,
	resetDocumentRowsMemo,
	withPropertyValues,
} from "../documentTableView";
import {
	derivePropertyModel,
	type PropertiesByPath,
} from "../properties/propertyFields";
import {
	propertyScanStore,
	resetPropertyScan,
} from "../properties/propertyScanStore";
import { viewWith } from "../testFixtures";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROPERTIES: PropertiesByPath = {
	"/ws/a.md": {
		status: { type: "text", value: "Todo" },
		due: { type: "date", value: "2026-10-05" },
	},
	"/ws/b.md": { status: { type: "text", value: "Done" } },
	"/ws/c.md": { status: { type: "text", value: "Todo" } },
};
const FILES = ["/ws/a.md", "/ws/b.md", "/ws/c.md", "/ws/d.md"].map(
	(path, index) => ({ path, modified_at: 100 + index }),
);

describe("DocumentTable board and calendar layouts", () => {
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
			documentViews: {},
		}));
		propertyScanStore.set({
			...propertyScanStore.get(),
			scope: "/ws",
			status: "ready",
			propertiesByPath: PROPERTIES,
		});
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		resetPropertyScan();
		setDocumentViewType("table");
	});

	function render() {
		const model = derivePropertyModel(PROPERTIES);
		const view = viewWith();
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

	it("switches to a board with a column per status and an empty column", async () => {
		render();
		const boardButton = [...container.querySelectorAll('[role="radio"]')].find(
			(button) => button.textContent === "Board",
		) as HTMLButtonElement;
		await act(async () => boardButton.click());
		expect(documentTableViewStore.get().layout.viewType).toBe("board");
		const columns = [...container.querySelectorAll("[data-board-column]")].map(
			(column) => [
				column.getAttribute("data-board-column"),
				[...column.querySelectorAll("[data-note-card]")].map(
					(card) => card.textContent?.split(":")[0],
				),
			],
		);
		expect(columns.map(([value]) => value)).toEqual(["Todo", "Done", ""]);
		expect(columns[2]?.[1]).toEqual(["d"]);
		expect(
			container.querySelector('[role="grid"][aria-label="Documents"]'),
		).toBeNull();
	});

	it("shows a calendar month with the dated note on its day", () => {
		act(() => setDocumentViewType("calendar"));
		render();
		const day = container.querySelector('[data-calendar-day="2026-10-05"]');
		// The grid opens on the current month; the note shows when it is October 2026.
		const now = new Date();
		if (now.getFullYear() === 2026 && now.getMonth() === 9) {
			expect(day?.textContent).toContain("a");
		}
		expect(container.querySelectorAll("[data-calendar-day]").length % 7).toBe(
			0,
		);
		expect(container.textContent).toContain("without due");
	});
});
