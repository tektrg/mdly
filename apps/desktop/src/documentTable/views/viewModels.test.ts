import { describe, expect, it } from "vitest";
import type { DocumentTableRow } from "../documentTableView";
import { sanitizeDocumentViews } from "../properties/documentViews";
import type {
	PropertyField,
	PropertyRowValues,
} from "../properties/propertyFields";
import {
	BOARD_MAX_VALUE_COLUMNS,
	boardFieldCandidates,
	buildBoardModel,
	moveTargetsFor,
	resolveBoardField,
} from "./boardModel";
import {
	buildCalendarModel,
	calendarMoveTargets,
	resolveCalendarField,
	shiftDate,
	shiftMonth,
} from "./calendarModel";

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
	label: "Status",
	type: "select",
	options: ["Todo", "Done"],
	documentCount: 3,
};
const DUE: PropertyField = {
	id: "prop:due",
	label: "due",
	type: "date",
	documentCount: 2,
};

describe("board model", () => {
	it("defaults to the status field, then the first select", () => {
		const kind = { ...STATUS, id: "prop:kind" as const, label: "kind" };
		expect(resolveBoardField([kind, STATUS], null)?.id).toBe("prop:status");
		expect(resolveBoardField([kind, STATUS], "prop:kind")?.id).toBe(
			"prop:kind",
		);
		expect(resolveBoardField([kind], "prop:gone")?.id).toBe("prop:kind");
		expect(resolveBoardField([DUE], null)).toBeNull();
	});

	it("puts each card in its value's column, in input order, empty column last", () => {
		const rows = [
			row("c", { "prop:status": "Done" }),
			row("a", { "prop:status": "Todo" }),
			row("b"),
			row("d", { "prop:status": "Todo" }),
			row("e", { "prop:status": "Later" }),
		];
		const model = buildBoardModel(rows, STATUS);
		expect(
			model.columns.map((column) => [
				column.label,
				column.rows.map((card) => card.name),
			]),
		).toEqual([
			["Todo", ["a", "d"]],
			["Done", ["c"]],
			["Later", ["e"]],
			["No Status", ["b"]],
		]);
		expect(model.columns[model.columns.length - 1]?.value).toBeNull();
	});

	it("caps rendered cards per column but counts them all", () => {
		const rows = Array.from({ length: 7 }, (_, index) =>
			row(`n${index}`, { "prop:status": "Todo" }),
		);
		const todo = buildBoardModel(rows, STATUS, { limitFor: () => 5 })
			.columns[0];
		expect(todo?.rows).toHaveLength(5);
		expect(todo?.total).toBe(7);
	});
});

describe("calendar model", () => {
	it("defaults to due, then the first date field", () => {
		const start = { ...DUE, id: "prop:start" as const, label: "start" };
		expect(resolveCalendarField([start, DUE], null)?.id).toBe("prop:due");
		expect(resolveCalendarField([start], null)?.id).toBe("prop:start");
		expect(resolveCalendarField([STATUS], null)).toBeNull();
	});

	it("lays out whole Monday-first weeks and buckets notes by date", () => {
		const rows = [
			row("a", { "prop:due": "2026-10-05" }),
			row("b", { "prop:due": "2026-10-05" }),
			row("c", { "prop:due": "2026-09-28" }),
			row("d", { "prop:due": "2027-01-01" }),
			row("e"),
		];
		const model = buildCalendarModel(rows, DUE, { year: 2026, month: 9 }, 1);
		// Oct 2026 starts on a Thursday: the grid opens on Monday Sep 28.
		expect(model.weeks[0]?.[0]?.date).toBe("2026-09-28");
		expect(model.weeks[0]?.[0]?.inMonth).toBe(false);
		expect(model.weeks.every((week) => week.length === 7)).toBe(true);
		const lastWeek = model.weeks[model.weeks.length - 1];
		expect(lastWeek?.[6]?.date).toBe("2026-11-01");
		const fifth = model.weeks.flat().find((day) => day.date === "2026-10-05");
		expect(fifth?.rows.map((card) => card.name)).toEqual(["a"]);
		expect(fifth?.total).toBe(2);
		expect(model.weeks[0]?.[0]?.rows.map((card) => card.name)).toEqual(["c"]);
		expect(model.outsideCount).toBe(1);
		expect(model.undatedCount).toBe(1);
	});

	it("shifts months across year boundaries", () => {
		expect(shiftMonth({ year: 2026, month: 0 }, -1)).toEqual({
			year: 2025,
			month: 11,
		});
		expect(shiftMonth({ year: 2026, month: 11 }, 1)).toEqual({
			year: 2027,
			month: 0,
		});
	});
});

describe("saved view layout persistence", () => {
	it("keeps a valid layout and reads old or bad entries as a table", () => {
		const base = { name: "V", sort: { column: "name", direction: "asc" } };
		const sanitized = sanitizeDocumentViews({
			"/ws": {
				saved: [
					{ ...base, id: "a", viewType: "board", boardField: "prop:status" },
					{ ...base, id: "b", viewType: "calendar", calendarField: "prop:due" },
					{ ...base, id: "c" },
					{ ...base, id: "d", viewType: "gallery", boardField: "status" },
				],
			},
		});
		const layouts = sanitized["/ws"]?.saved.map(
			({ viewType, boardField, calendarField }) => ({
				viewType,
				boardField,
				calendarField,
			}),
		);
		expect(layouts).toEqual([
			{ viewType: "board", boardField: "prop:status", calendarField: null },
			{ viewType: "calendar", boardField: null, calendarField: "prop:due" },
			{ viewType: "table", boardField: null, calendarField: null },
			{ viewType: "table", boardField: null, calendarField: null },
		]);
	});
});

describe("QA pass 2: board limits and keyboard moves", () => {
	const TEXT: PropertyField = {
		id: "prop:owner",
		label: "owner",
		type: "text",
		documentCount: 40,
	};

	it("offers free text as a board only with at most 30 distinct values", () => {
		const few = Array.from({ length: 40 }, (_, index) =>
			row(`f${index}`, { "prop:owner": `p${index % 5}` }),
		);
		const many = Array.from({ length: 40 }, (_, index) =>
			row(`m${index}`, { "prop:owner": `p${index}` }),
		);
		expect(boardFieldCandidates([TEXT, STATUS], few).map((f) => f.id)).toEqual([
			"prop:owner",
			"prop:status",
		]);
		expect(boardFieldCandidates([TEXT, STATUS], many).map((f) => f.id)).toEqual(
			["prop:status"],
		);
	});

	it("caps value columns at 30, folding the rest into Other, empty column last", () => {
		const rows = Array.from({ length: 45 }, (_, index) =>
			row(`n${index}`, { "prop:status": `v${index}` }),
		);
		const model = buildBoardModel(rows, { ...STATUS, options: [] });
		const kinds = model.columns.map((column) => column.kind);
		expect(kinds.filter((kind) => kind === "value")).toHaveLength(
			BOARD_MAX_VALUE_COLUMNS,
		);
		expect(kinds.slice(-2)).toEqual(["other", "empty"]);
		expect(model.columns[BOARD_MAX_VALUE_COLUMNS]?.total).toBe(15);
		expect(model.columns[BOARD_MAX_VALUE_COLUMNS]?.label).toBe(
			"Other (15 values)",
		);
	});

	it("offers every droppable column but the card's own as a move target", () => {
		const card = row("a", { "prop:status": "Todo" });
		const model = buildBoardModel([card, row("b")], STATUS);
		expect(moveTargetsFor(card, model).map((column) => column.label)).toEqual([
			"Done",
			"No Status",
		]);
	});

	it("offers day moves and keeps the day's full list for +N more", () => {
		expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
		expect(calendarMoveTargets("2026-12-31").map((t) => t.date)).toEqual([
			"2026-12-30",
			"2027-01-01",
			"2027-01-07",
			"2026-12-24",
			null,
		]);
		const rows = ["a", "b", "c", "d"].map((name) =>
			row(name, { "prop:due": "2026-10-05" }),
		);
		const day = buildCalendarModel(rows, DUE, { year: 2026, month: 9 }, 2)
			.weeks.flat()
			.find((candidate) => candidate.date === "2026-10-05");
		expect(day?.rows).toHaveLength(2);
		expect(day?.allRows.map((card) => card.name)).toEqual(["a", "b", "c", "d"]);
	});
});
