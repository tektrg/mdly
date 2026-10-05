// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentTableRow } from "../documentTableView";
import type {
	PropertyField,
	PropertyRowValues,
} from "../properties/propertyFields";
import { DocumentBoard } from "./DocumentBoard";
import { DocumentCalendar } from "./DocumentCalendar";

const writeDocumentProperty = vi.fn(
	async (..._args: unknown[]) => ({ ok: true, changed: true }),
);
vi.mock("../properties/propertyWrite", () => ({
	writeDocumentProperty: (...args: unknown[]) => writeDocumentProperty(...args),
}));

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function row(name: string, properties: PropertyRowValues = {}): DocumentTableRow {
	const path = `/ws/${name}.md`;
	return {
		path,
		openPath: path,
		name,
		folderLabel: "—",
		modifiedAt: 0,
		createdAt: 0,
		searchName: name,
		isActive: false,
		isPinnedOffFilter: false,
		properties,
	};
}

const STATUS: PropertyField = {
	id: "prop:status",
	label: "status",
	type: "select",
	options: ["Todo", "Done"],
	documentCount: 2,
};
const DUE: PropertyField = { id: "prop:due", label: "due", type: "date", documentCount: 4 };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	writeDocumentProperty.mockClear();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

async function openMenu(label: string) {
	const trigger = container.querySelector(
		`[aria-label="${label}"]`,
	) as HTMLButtonElement;
	expect(trigger).not.toBeNull();
	await act(async () => {
		trigger.click();
	});
	return [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
}

describe("board interactions", () => {
	const rows = [row("a", { "prop:status": "Todo" }), row("b", { "prop:status": "Done" })];

	function renderBoard(fields: PropertyField[] = [STATUS], reading = false) {
		act(() => {
			root.render(
				<DocumentBoard
					rows={fields.length ? rows : []}
					fields={fields}
					boardField={null}
					propertyColumns={[]}
					isReadingProperties={reading}
					onOpenDocument={() => {}}
				/>,
			);
		});
	}

	it("a read-only (built-in) board field: cards don't drag and Move to says why", async () => {
		const folder: PropertyField = { ...STATUS, id: "file:folder", label: "Folder", readOnly: true };
		act(() => {
			root.render(
				<DocumentBoard
					rows={[row("a", { "file:folder": "notes" })]}
					fields={[folder]}
					boardField="file:folder"
					propertyColumns={[]}
					onOpenDocument={() => {}}
				/>,
			);
		});
		const card = container.querySelector("[data-note-card]") as HTMLElement;
		expect(card.getAttribute("draggable")).toBe("false");
		const items = await openMenu("Move a");
		expect(items.map((item) => item.textContent)).toEqual(["Can't move — this comes from the file"]);
		expect(writeDocumentProperty).not.toHaveBeenCalled();
	});

	it("moves a card from the keyboard menu, not offering its own column", async () => {
		renderBoard();
		const items = await openMenu("Move a");
		expect(items.map((item) => item.textContent)).toEqual(["Done", "No status"]);
		await act(async () => {
			items[0]?.click();
		});
		expect(writeDocumentProperty).toHaveBeenCalledWith(rows[0], "status", "Done");
	});

	it("says it is reading properties while the scan is pending", () => {
		renderBoard([], true);
		expect(container.textContent).toContain("Reading properties…");
		expect(container.textContent).not.toContain("needs a property");
	});

	it("keeps the drop highlight while dragging over a card inside the column", () => {
		renderBoard();
		const column = container.querySelector(
			'[data-board-column="Todo"]',
		) as HTMLElement;
		const card = column.querySelector("[data-note-card]") as HTMLElement;
		const over = new Event("dragover", { bubbles: true, cancelable: true });
		Object.assign(over, {
			dataTransfer: { types: ["application/x-mdly-note-path"], dropEffect: "" },
		});
		act(() => {
			column.dispatchEvent(over);
		});
		expect(column.className).toContain("ring-1");
		const leave = new Event("dragleave", { bubbles: true });
		Object.assign(leave, { relatedTarget: card });
		act(() => {
			column.dispatchEvent(leave);
		});
		expect(column.className).toContain("ring-1");
		const out = new Event("dragleave", { bubbles: true });
		Object.assign(out, { relatedTarget: document.body });
		act(() => {
			column.dispatchEvent(out);
		});
		expect(column.className).not.toContain("ring-1");
	});

	it("skips the write when a card is dropped on its own column", () => {
		renderBoard();
		const column = container.querySelector(
			'[data-board-column="Todo"]',
		) as HTMLElement;
		const drop = new Event("drop", { bubbles: true, cancelable: true });
		Object.assign(drop, {
			dataTransfer: { getData: () => "/ws/a.md", types: [] },
		});
		act(() => {
			column.dispatchEvent(drop);
		});
		expect(writeDocumentProperty).not.toHaveBeenCalled();
		const done = container.querySelector('[data-board-column="Done"]') as HTMLElement;
		const drop2 = new Event("drop", { bubbles: true, cancelable: true });
		Object.assign(drop2, {
			dataTransfer: { getData: () => "/ws/a.md", types: [] },
		});
		act(() => {
			done.dispatchEvent(drop2);
		});
		expect(writeDocumentProperty).toHaveBeenCalledWith(rows[0], "status", "Done");
	});
});

describe("calendar interactions", () => {
	it("+N more is a button listing every note on the day", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(2026, 9, 15));
		const rows = ["a", "b", "c", "d", "e"].map((name) =>
			row(name, { "prop:due": "2026-10-05" }),
		);
		const opened: string[] = [];
		act(() => {
			root.render(
				<DocumentCalendar
					rows={rows}
					fields={[DUE]}
					calendarField={null}
					onOpenDocument={(target) => opened.push(target.name)}
				/>,
			);
		});
		vi.useRealTimers();
		const items = await openMenu("All 5 notes on 2026-10-05");
		expect(items.map((item) => item.textContent)).toEqual(["a", "b", "c", "d", "e"]);
		await act(async () => {
			items[4]?.click();
		});
		expect(opened).toEqual(["e"]);
	});
});
