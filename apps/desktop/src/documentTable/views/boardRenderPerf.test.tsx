// @vitest-environment happy-dom
/**
 * Render-count regression test for the board: an unrelated app update must
 * not re-render every card. Each card render is counted through a memo
 * wrapper with the same (default, shallow) comparison as the real card.
 */
import { act, type ComponentProps, memo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspacePathStore, workspaceStore } from "../../store/state";
import type { DocumentRowListMenu } from "../DocumentRowMenu";
import { DocumentTable } from "../DocumentTable";
import {
	documentTableViewStore,
	setDocumentViewType,
} from "../documentTableStore";
import {
	buildDocumentRows,
	type DocumentTableRow,
	resetDocumentRowsMemo,
	withPropertyValues,
} from "../documentTableView";
import {
	derivePropertyModel,
	type PropertiesByPath,
	type PropertyField,
} from "../properties/propertyFields";
import {
	propertyScanStore,
	resetPropertyScan,
} from "../properties/propertyScanStore";
import { usePropertyModel } from "../properties/usePropertyModel";
import { viewWith } from "../testFixtures";
import { DocumentBoard } from "./DocumentBoard";

const counter = vi.hoisted(() => ({ renders: new Map<string, number>() }));

vi.mock("./BoardCard", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./BoardCard")>();
	const Real = actual.BoardCard;
	const Counted = memo(function CountedBoardCard(
		props: ComponentProps<typeof Real>,
	) {
		counter.renders.set(
			props.row.path,
			(counter.renders.get(props.row.path) ?? 0) + 1,
		);
		return <Real {...props} />;
	});
	return { ...actual, BoardCard: Counted };
});

vi.mock("../properties/propertyWrite", () => ({
	writeDocumentProperty: async () => ({ ok: true, changed: true }),
}));
vi.mock("../../desktopApi", () => ({
	desktopApi: { readFileText: async () => "body", platform: "darwin" },
}));

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CARD_COUNT = 500;
const STATUSES = ["Todo", "Doing", "Done", "Blocked", "Later"];
const STATUS: PropertyField = {
	id: "prop:status",
	label: "status",
	type: "select",
	options: STATUSES,
	documentCount: CARD_COUNT,
};

function syntheticRows(): DocumentTableRow[] {
	return Array.from({ length: CARD_COUNT }, (_, index) => {
		const path = `/ws/note-${index}.md`;
		return {
			path,
			openPath: path,
			name: `note-${index}`,
			folderLabel: "—",
			modifiedAt: index,
			createdAt: index,
			searchName: `note-${index}`,
			isActive: false,
			isPinnedOffFilter: false,
			properties: {
				"prop:status": STATUSES[index % STATUSES.length] as string,
			},
		};
	});
}

function totalRenders(): number {
	let sum = 0;
	for (const count of counter.renders.values()) sum += count;
	return sum;
}

/** A fresh-but-equal menu, as `MainPanel` builds on every render. */
function newRowMenu(): DocumentRowListMenu {
	return {
		isPinned: () => false,
		revealLabel: "Reveal in Finder",
		onRevealPath: () => {},
		onCopyPath: () => {},
		onMovePath: () => {},
		onTogglePin: () => {},
		onDeletePath: () => {},
	};
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	counter.renders.clear();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	resetPropertyScan();
});

describe("board render counts at 500 cards", () => {
	const rows = syntheticRows();
	// Stable like the app's (memoized property model / saved view settings);
	// only the MainPanel-built props are fresh on every render.
	const fields = [STATUS];
	const propertyColumns: PropertyField["id"][] = [];
	function renderBoard() {
		act(() => {
			root.render(
				<DocumentBoard
					rows={rows}
					fields={fields}
					boardField={null}
					propertyColumns={propertyColumns}
					rowMenu={newRowMenu()}
					onOpenDocument={() => {}}
				/>,
			);
		});
	}

	it("initial render mounts every card once (timed)", () => {
		const start = performance.now();
		renderBoard();
		const ms = performance.now() - start;
		console.info(`[perf 500] board initial render: ${ms.toFixed(1)} ms`);
		console.info(`[perf 500] cards rendered: ${totalRenders()}`);
		expect(container.querySelectorAll("[data-board-card]").length).toBe(
			CARD_COUNT,
		);
	});

	it("a parent re-render with new-but-equal rowMenu/onOpenDocument re-renders no card", () => {
		renderBoard();
		counter.renders.clear();
		renderBoard();
		console.info(`[perf 500] cards re-rendered by parent: ${totalRenders()}`);
		expect(totalRenders()).toBe(0);
	});

	it("a scan tick (progress only) re-renders no card", async () => {
		renderBoard();
		counter.renders.clear();
		await act(async () =>
			propertyScanStore.set({
				...propertyScanStore.get(),
				scannedCount: propertyScanStore.get().scannedCount + 1,
			}),
		);
		expect(totalRenders()).toBe(0);
	});

	it("a heading for one note re-renders only that card", async () => {
		renderBoard();
		counter.renders.clear();
		await act(async () =>
			propertyScanStore.set({
				...propertyScanStore.get(),
				headingByPath: { "/ws/note-7.md": "Seven" },
			}),
		);
		console.info(
			`[perf 500] cards re-rendered by a heading: ${totalRenders()}`,
		);
		expect([...counter.renders.keys()]).toEqual(["/ws/note-7.md"]);
	});

	it("a drop re-renders only cards of the two affected columns", () => {
		renderBoard();
		counter.renders.clear();
		const done = container.querySelector(
			'[data-board-column="Done"]',
		) as HTMLElement;
		const drop = new Event("drop", { bubbles: true, cancelable: true });
		Object.assign(drop, {
			dataTransfer: { getData: () => "/ws/note-0.md", types: [] },
		});
		act(() => {
			done.dispatchEvent(drop);
		});
		console.info(`[perf 500] cards re-rendered by a drop: ${totalRenders()}`);
		// Todo + Done hold 200 cards; only the moved one needs a render.
		expect(totalRenders()).toBeLessThanOrEqual(2);
		expect(counter.renders.has("/ws/note-0.md")).toBe(true);
	});
});

describe("DocumentTable board: scan ticks", () => {
	it("a scan progress tick re-renders no card", async () => {
		resetDocumentRowsMemo();
		const files = syntheticRows().map((row, index) => ({
			path: row.path,
			modified_at: index,
		}));
		const properties: PropertiesByPath = Object.fromEntries(
			files.map((file, index) => [
				file.path,
				{
					status: {
						type: "text",
						value: STATUSES[index % STATUSES.length] as string,
					},
				},
			]),
		);
		workspacePathStore.set("/ws");
		workspaceStore.set((state) => ({
			...state,
			workspacePath: "/ws",
			files,
			documentViews: {},
		}));
		propertyScanStore.set({
			...propertyScanStore.get(),
			scope: "/ws",
			status: "scanning",
			propertiesByPath: properties,
		});
		act(() => setDocumentViewType("board"));
		expect(documentTableViewStore.get().layout.viewType).toBe("board");
		const model = derivePropertyModel(properties);
		const view = viewWith();
		const rows = withPropertyValues(
			buildDocumentRows(files, "/ws"),
			model.valuesByPath,
		);
		try {
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
			expect(totalRenders()).toBeGreaterThan(0);
			counter.renders.clear();
			await act(async () =>
				propertyScanStore.set({
					...propertyScanStore.get(),
					scannedCount: propertyScanStore.get().scannedCount + 100,
					pendingCount: 400,
				}),
			);
			expect(totalRenders()).toBe(0);
		} finally {
			act(() => setDocumentViewType("table"));
		}
	});
});

describe("property model subscribers", () => {
	it("usePropertyModel ignores scan progress ticks", async () => {
		workspacePathStore.set("/ws");
		propertyScanStore.set({
			...propertyScanStore.get(),
			scope: "/ws",
			status: "scanning",
		});
		let renders = 0;
		function Probe() {
			usePropertyModel();
			renders += 1;
			return null;
		}
		act(() => root.render(<Probe />));
		renders = 0;
		await act(async () =>
			propertyScanStore.set({
				...propertyScanStore.get(),
				scannedCount: propertyScanStore.get().scannedCount + 100,
				pendingCount: 400,
			}),
		);
		expect(renders).toBe(0);
	});
});
