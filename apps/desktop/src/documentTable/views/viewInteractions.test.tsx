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

const writeDocumentProperty = vi.fn(async (..._args: unknown[]) => ({
	ok: true,
	changed: true,
}));
vi.mock("../properties/propertyWrite", () => ({
	writeDocumentProperty: (...args: unknown[]) => writeDocumentProperty(...args),
}));

vi.mock("../../desktopApi", () => ({
	desktopApi: { readFileText: async () => "body" },
}));

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function row(
	name: string,
	properties: PropertyRowValues = {},
): DocumentTableRow {
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
const DUE: PropertyField = {
	id: "prop:due",
	label: "due",
	type: "date",
	documentCount: 4,
};

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

async function pressOnCard(
	card: HTMLElement,
	key: string,
	init: KeyboardEventInit = {},
) {
	card.focus();
	await act(async () => {
		card.dispatchEvent(
			new KeyboardEvent("keydown", { key, bubbles: true, ...init }),
		);
	});
}

describe("board interactions", () => {
	const rows = [
		row("a", { "prop:status": "Todo" }),
		row("b", { "prop:status": "Done" }),
	];

	const onOpenDocument = vi.fn();
	beforeEach(() => onOpenDocument.mockClear());

	function renderBoard(
		fields: PropertyField[] = [STATUS],
		reading = false,
		compact = false,
		boardRows = rows,
	) {
		act(() => {
			root.render(
				<DocumentBoard
					rows={fields.length ? boardRows : []}
					fields={fields}
					boardField={null}
					propertyColumns={[]}
					isReadingProperties={reading}
					onOpenDocument={onOpenDocument}
					compact={compact}
				/>,
			);
		});
	}

	it("a read-only (built-in) board field: cards don't drag and Move to says why", async () => {
		const folder: PropertyField = {
			...STATUS,
			id: "file:folder",
			label: "Folder",
			readOnly: true,
		};
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
		await pressOnCard(card, "ArrowRight", { altKey: true });
		expect(writeDocumentProperty).not.toHaveBeenCalled();
	});

	it("clicking a card opens the note, like a table row (no peek panel)", async () => {
		renderBoard();
		const card = container.querySelector(
			'[data-board-card="/ws/a.md"]',
		) as HTMLElement;
		await act(async () => card.click());
		expect(onOpenDocument).toHaveBeenCalledWith(rows[0]);
		expect(container.querySelector("[data-board-peek]")).toBeNull();
	});

	it("Enter on a focused card opens it; Space no longer peeks", async () => {
		renderBoard();
		const card = container.querySelector(
			'[data-board-card="/ws/b.md"]',
		) as HTMLElement;
		await pressOnCard(card, " ");
		expect(onOpenDocument).not.toHaveBeenCalled();
		expect(container.querySelector("[data-board-peek]")).toBeNull();
		await pressOnCard(card, "Enter");
		expect(onOpenDocument).toHaveBeenCalledWith(rows[1]);
	});

	it("compact (file open) still renders columns + cards and highlights the open note", () => {
		renderBoard([STATUS], false, true, [
			{ ...rows[0], isActive: true } as DocumentTableRow,
			rows[1] as DocumentTableRow,
		]);
		expect(container.querySelector("[data-board-compact]")).not.toBeNull();
		expect(
			container.querySelectorAll("[data-board-column-index]").length,
		).toBeGreaterThanOrEqual(2);
		const active = container.querySelector(
			'[data-board-card="/ws/a.md"]',
		) as HTMLElement;
		expect(active.getAttribute("aria-current")).toBe("page");
		expect(
			container
				.querySelector('[data-board-card="/ws/b.md"]')
				?.hasAttribute("aria-current"),
		).toBe(false);
		// Toolbar (Columns by / card properties) collapses away.
		expect(container.querySelector('[aria-label="Board settings"]')).toBeNull();
	});

	it("right-edge fade recalculates when columns are added, not only on resize", () => {
		let viewport = 10_000;
		const columnWidth = 200;
		const proto = HTMLElement.prototype;
		const original = {
			client: Object.getOwnPropertyDescriptor(proto, "clientWidth"),
			scroll: Object.getOwnPropertyDescriptor(proto, "scrollWidth"),
		};
		Object.defineProperty(proto, "clientWidth", {
			configurable: true,
			get(this: HTMLElement) {
				return this.getAttribute("role") === "application" ? viewport : 0;
			},
		});
		Object.defineProperty(proto, "scrollWidth", {
			configurable: true,
			get(this: HTMLElement) {
				return (
					this.querySelectorAll("[data-board-column-index]").length *
					columnWidth
				);
			},
		});
		try {
			const render = (options: string[]) =>
				act(() => {
					root.render(
						<DocumentBoard
							rows={rows}
							fields={[{ ...STATUS, options }]}
							boardField={null}
							propertyColumns={[]}
							onOpenDocument={() => {}}
						/>,
					);
				});
			render(["Todo", "Done"]);
			expect(container.querySelector("[data-board-overflow-fade]")).toBeNull();
			viewport =
				container.querySelectorAll("[data-board-column-index]").length *
				columnWidth;
			render(["Todo", "Done", "Later", "Someday"]);
			expect(
				container.querySelector("[data-board-overflow-fade]"),
			).not.toBeNull();
		} finally {
			for (const [key, descriptor] of [
				["clientWidth", original.client],
				["scrollWidth", original.scroll],
			] as const) {
				if (descriptor) Object.defineProperty(proto, key, descriptor);
				else delete (proto as unknown as Record<string, unknown>)[key];
			}
		}
	});

	it("card menu lists the card actions", async () => {
		renderBoard();
		const items = await openMenu("Actions for a");
		expect(items.map((item) => item.textContent)).not.toContain("PeekSpace");
		expect(items.map((item) => item.textContent)).toEqual(
			expect.arrayContaining(["Open↵", "Duplicate", "Rename…", "Delete…"]),
		);
	});

	it("right-click opens the shared card menu for that card; its actions target it", async () => {
		renderBoard();
		expect(document.querySelectorAll('[role="menu"]').length).toBe(0);
		const card = container.querySelector(
			'[data-board-card="/ws/b.md"]',
		) as HTMLElement;
		await act(async () => {
			card.dispatchEvent(
				new MouseEvent("contextmenu", {
					bubbles: true,
					cancelable: true,
					clientX: 40,
					clientY: 50,
				}),
			);
		});
		const items = [
			...document.querySelectorAll('[role="menuitem"]'),
		] as HTMLElement[];
		expect(document.querySelectorAll('[role="menu"]').length).toBe(1);
		const open = items.find((item) => item.textContent === "Open↵");
		expect(open).toBeDefined();
		await act(async () => open?.click());
		expect(onOpenDocument).toHaveBeenCalledWith(rows[1]);
	});

	it("Opt+→ moves a card to the next column, optimistically, writing the board key", async () => {
		renderBoard();
		const card = container.querySelector(
			'[data-board-card="/ws/a.md"]',
		) as HTMLElement;
		await pressOnCard(card, "ArrowRight", { altKey: true });
		expect(writeDocumentProperty).toHaveBeenCalledWith(
			rows[0],
			"status",
			"Done",
		);
	});

	it("titles a card from front-matter title before the file name", () => {
		act(() => {
			root.render(
				<DocumentBoard
					rows={[
						row("delivery", {
							"prop:status": "Todo",
							"prop:title": "Real title",
						}),
					]}
					fields={[STATUS]}
					boardField={null}
					propertyColumns={[]}
					onOpenDocument={() => {}}
				/>,
			);
		});
		expect(
			container.querySelector("[data-board-card]")?.getAttribute("aria-label"),
		).toBe("Real title");
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
		expect(column.className).toContain("ring-[3px]");
		const leave = new Event("dragleave", { bubbles: true });
		Object.assign(leave, { relatedTarget: card });
		act(() => {
			column.dispatchEvent(leave);
		});
		expect(column.className).toContain("ring-[3px]");
		const out = new Event("dragleave", { bubbles: true });
		Object.assign(out, { relatedTarget: document.body });
		act(() => {
			column.dispatchEvent(out);
		});
		expect(column.className).not.toContain("ring-[3px]");
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
		const done = container.querySelector(
			'[data-board-column="Done"]',
		) as HTMLElement;
		const drop2 = new Event("drop", { bubbles: true, cancelable: true });
		Object.assign(drop2, {
			dataTransfer: { getData: () => "/ws/a.md", types: [] },
		});
		act(() => {
			done.dispatchEvent(drop2);
		});
		expect(writeDocumentProperty).toHaveBeenCalledWith(
			rows[0],
			"status",
			"Done",
		);
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
		expect(items.map((item) => item.textContent)).toEqual([
			"a",
			"b",
			"c",
			"d",
			"e",
		]);
		await act(async () => {
			items[4]?.click();
		});
		expect(opened).toEqual(["e"]);
	});
});
