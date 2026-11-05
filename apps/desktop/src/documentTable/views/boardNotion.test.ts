import { describe, expect, it } from "vitest";
import type { DocumentTableRow } from "../documentTableView";
import {
	DEFAULT_BOARD_VIEW_SETTINGS,
	sanitizeSavedView,
} from "../properties/documentViews";
import { firstHeadingOf } from "../properties/firstHeading";
import type {
	PropertyField,
	PropertyRowValues,
} from "../properties/propertyFields";
import {
	boardColumnKey,
	buildBoardModel,
	EMPTY_COLUMN_KEY,
	movedBoardValue,
	rawBoardValue,
	reorderColumnKeys,
	resolveCardTitle,
	UNREADABLE_COLUMN_KEY,
} from "./boardModel";

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
	options: [],
	documentCount: 0,
};

describe("card title", () => {
	it("prefers front-matter title, then the first H1, then the file name", () => {
		expect(
			resolveCardTitle(row("delivery", { "prop:title": " Ship it " }), "H"),
		).toBe("Ship it");
		expect(resolveCardTitle(row("delivery"), "Board upgrade")).toBe(
			"Board upgrade",
		);
		expect(
			resolveCardTitle(row("delivery", { "prop:title": "  " }), null),
		).toBe("delivery");
	});

	it("finds the first H1 after front matter, skipping code fences and H2s", () => {
		const text =
			"---\ntitle: x\n---\n## Sub\n```\n# not this\n```\n# The **Real** one #\n# second";
		expect(firstHeadingOf(text)).toBe("The Real one");
		expect(firstHeadingOf("no heading\n#hashtag")).toBeNull();
	});
});

describe("value merging", () => {
	it("merges values differing by case/whitespace under the commonest spelling", () => {
		const model = buildBoardModel(
			[
				row("a", { "prop:status": "done" }),
				row("b", { "prop:status": "DONE" }),
				row("c", { "prop:status": " done " }),
				row("d", { "prop:status": "In  Progress" }),
				row("e", { "prop:status": "in progress" }),
			],
			{ ...STATUS, options: ["DONE", "done", "In  Progress"] },
		);
		const values = model.columns.filter((column) => column.kind === "value");
		expect(values.map((column) => [column.label, column.total])).toEqual([
			["done", 3],
			["In  Progress", 2],
		]);
		expect(values[0]?.key).toBe(boardColumnKey("DONE"));
	});

	it("groups unreadable front matter apart, after the empty column", () => {
		const model = buildBoardModel([row("a"), row("bad")], STATUS, {
			invalidPaths: new Set(["/ws/bad.md"]),
		});
		expect(model.columns.map((column) => column.key)).toEqual([
			EMPTY_COLUMN_KEY,
			UNREADABLE_COLUMN_KEY,
		]);
	});

	it("applies saved order, hidden columns, colours and hide-empty", () => {
		const rows = [
			row("a", { "prop:status": "todo" }),
			row("b", { "prop:status": "done" }),
			row("c", { "prop:status": "doing" }),
		];
		const model = buildBoardModel(rows, STATUS, {
			settings: {
				...DEFAULT_BOARD_VIEW_SETTINGS,
				columnOrder: ["v:done", "v:gone"],
				hiddenColumns: ["v:doing"],
				columnColors: { "v:done": "green" },
				hideEmptyColumns: true,
			},
		});
		expect(model.columns.map((column) => column.label)).toEqual([
			"done",
			"todo",
		]);
		expect(model.columns[0]?.color).toBe("green");
		expect(model.hiddenColumns.map((column) => column.label)).toEqual([
			"doing",
		]);
	});

	it("reorders keys by drag target", () => {
		expect(reorderColumnKeys(["a", "b", "c"], [], "c", "a")).toEqual([
			"c",
			"a",
			"b",
		]);
		expect(reorderColumnKeys(["a", "b", "c"], ["b"], "b", null)).toEqual([
			"a",
			"c",
			"b",
		]);
	});
});

describe("move value (front-matter rewrite)", () => {
	const done = { kind: "value" as const, value: "done" };
	const todo = { kind: "value" as const, value: "todo" };
	const none = { kind: "empty" as const, value: null };

	it("sets a scalar, and removes it for the empty column", () => {
		const card = row("a", { "prop:status": "todo" });
		expect(movedBoardValue(card, "prop:status", todo, done)).toBe("done");
		expect(movedBoardValue(card, "prop:status", todo, none)).toBeNull();
	});

	it("replaces only the source column's value in a list", () => {
		const card = row("a", { "prop:status": ["TODO", "urgent"] });
		expect(movedBoardValue(card, "prop:status", todo, done)).toEqual([
			"done",
			"urgent",
		]);
		expect(movedBoardValue(card, "prop:status", todo, none)).toEqual([
			"urgent",
		]);
		const dupe = row("b", { "prop:status": ["todo", "done"] });
		expect(movedBoardValue(dupe, "prop:status", todo, done)).toEqual(["done"]);
		const only = row("c", { "prop:status": ["todo"] });
		expect(movedBoardValue(only, "prop:status", todo, none)).toBeNull();
	});

	it("undo writes back the original raw value", () => {
		expect(
			rawBoardValue(row("a", { "prop:status": ["x", "y"] }), "prop:status"),
		).toEqual(["x", "y"]);
		expect(rawBoardValue(row("a", { "prop:status": "x" }), "prop:status")).toBe(
			"x",
		);
		expect(rawBoardValue(row("a"), "prop:status")).toBeNull();
	});

	it("undo keeps the original types of list items", () => {
		// The scan only yields string lists today; guard the writer anyway.
		const mixed = {
			"prop:status": [1, 2, true],
		} as unknown as PropertyRowValues;
		expect(rawBoardValue(row("a", mixed), "prop:status")).toEqual([1, 2, true]);
	});
});

describe("saved-view board settings", () => {
	const base = {
		id: "v1",
		name: "Board",
		sort: { column: "name", direction: "asc" },
	};

	it("defaults old views (no board key) and keeps valid settings", () => {
		expect(sanitizeSavedView(base)?.board).toEqual(DEFAULT_BOARD_VIEW_SETTINGS);
		const kept = sanitizeSavedView({
			...base,
			board: {
				columnOrder: ["v:done", 3, "v:done"],
				hiddenColumns: ["v:x"],
				columnColors: { "v:done": "green", "v:x": "neon" },
				cardProperties: ["prop:due", "bogus"],
				hideEmptyColumns: true,
			},
		});
		expect(kept?.board).toEqual({
			columnOrder: ["v:done"],
			hiddenColumns: ["v:x"],
			columnColors: { "v:done": "green" },
			cardProperties: ["prop:due"],
			hideEmptyColumns: true,
		});
	});

	it("round-trips through JSON", () => {
		const view = sanitizeSavedView({
			...base,
			board: { ...DEFAULT_BOARD_VIEW_SETTINGS, cardProperties: [] },
		});
		expect(sanitizeSavedView(JSON.parse(JSON.stringify(view)))).toEqual(view);
	});
});
