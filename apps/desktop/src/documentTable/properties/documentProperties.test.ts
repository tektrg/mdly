import { beforeEach, describe, expect, it } from "vitest";
import type { ScannedFrontMatterProperty } from "../../desktopApi/types";
import { evaluateDocumentRowsForTest } from "../documentTableEngine";
import {
	applyDocumentTableView,
	buildDocumentRows,
	createDefaultDocumentTableView,
	type DocumentTableView,
	resetDocumentRowsMemo,
	withPropertyValues,
} from "../documentTableView";
import { type PropertyFilter, sanitizeDocumentViews } from "./documentViews";
import { derivePropertyModel } from "./propertyFields";
import { buildPropertyGroupTree } from "./propertyGroupTree";

type Props = Record<string, ScannedFrontMatterProperty>;

const t = (value: string): ScannedFrontMatterProperty => ({
	type: "text",
	value,
});
const n = (value: number): ScannedFrontMatterProperty => ({
	type: "number",
	value,
});
const tags = (...value: string[]): ScannedFrontMatterProperty => ({
	type: "tags",
	value,
});

const PROPS: Record<string, Props> = {
	"/ws/a.md": { status: t("Todo"), priority: n(2), tags: tags("work") },
	"/ws/b.md": { status: t("Done"), priority: n(1), tags: tags("work", "home") },
	"/ws/c.md": { status: t("Todo") },
	"/ws/d.md": {},
};

function setup(props: Record<string, Props> = PROPS) {
	resetDocumentRowsMemo();
	const files = Object.keys(props).map((path, index) => ({
		path,
		modified_at: 100 + index,
	}));
	const model = derivePropertyModel({ ...props });
	const rows = withPropertyValues(
		buildDocumentRows(files, "/ws"),
		model.valuesByPath,
	);
	return { rows, fields: model.fields };
}

function view(overrides: Partial<DocumentTableView>): DocumentTableView {
	return { ...createDefaultDocumentTableView(), ...overrides };
}

function names(
	rows: ReturnType<typeof setup>["rows"],
	v: DocumentTableView,
	fields: ReturnType<typeof setup>["fields"],
) {
	return applyDocumentTableView(rows, v, null, fields).map((row) => row.name);
}

beforeEach(() => resetDocumentRowsMemo());

describe("property columns in the document table engine", () => {
	it("sorts by a number property, documents without it last in both directions", () => {
		const { rows, fields } = setup();
		expect(
			names(
				rows,
				view({ sort: { column: "prop:priority", direction: "asc" } }),
				fields,
			),
		).toEqual(["b", "a", "c", "d"]);
		expect(
			names(
				rows,
				view({ sort: { column: "prop:priority", direction: "desc" } }),
				fields,
			),
		).toEqual(["a", "b", "c", "d"]);
	});

	it("falls back to the default sort for a property no document has", () => {
		const { rows, fields } = setup();
		expect(
			names(
				rows,
				view({ sort: { column: "prop:gone", direction: "asc" } }),
				fields,
			),
		).toEqual(["d", "c", "b", "a"]);
	});

	it("filters with has / is / tag chips, AND-ed, and keeps the sort", () => {
		const { rows, fields } = setup();
		const has: PropertyFilter = { fieldId: "prop:priority", kind: "has" };
		const todo: PropertyFilter = {
			fieldId: "prop:status",
			kind: "is",
			value: "Todo",
		};
		const home: PropertyFilter = {
			fieldId: "prop:tags",
			kind: "is",
			value: "home",
		};
		expect(names(rows, view({ propertyFilters: [has] }), fields)).toEqual([
			"b",
			"a",
		]);
		expect(names(rows, view({ propertyFilters: [has, todo] }), fields)).toEqual(
			["a"],
		);
		expect(names(rows, view({ propertyFilters: [home] }), fields)).toEqual([
			"b",
		]);
	});

	it("a chip on a property nobody carries matches nothing, never everything (decision E)", () => {
		const { rows, fields } = setup();
		expect(
			names(
				rows,
				view({ propertyFilters: [{ fieldId: "prop:gone", kind: "has" }] }),
				fields,
			),
		).toEqual([]);
	});

	it("combines the name box with chips", () => {
		const { rows, fields } = setup();
		expect(
			names(
				rows,
				view({
					filter: "c",
					propertyFilters: [{ fieldId: "prop:status", kind: "has" }],
				}),
				fields,
			),
		).toEqual(["c"]);
	});

	it("fast path equals one plain engine evaluate() on random property sets", () => {
		let seed = 7;
		const random = () => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			return seed / 2 ** 31;
		};
		const statuses = ["Todo", "Done", "Doing", "todo"];
		for (let round = 0; round < 60; round += 1) {
			const props: Record<string, Props> = {};
			for (let index = 0; index < 30; index += 1) {
				const entry: Props = {};
				if (random() < 0.7)
					entry.status = t(statuses[Math.floor(random() * 4)]);
				if (random() < 0.5) entry.priority = n(Math.floor(random() * 4));
				props[`/ws/n${index}.md`] = entry;
			}
			const { rows, fields } = setup(props);
			for (const column of ["prop:status", "prop:priority", "name"] as const) {
				for (const direction of ["asc", "desc"] as const) {
					const filters: PropertyFilter[] =
						round % 2 === 0 ? [{ fieldId: "prop:priority", kind: "has" }] : [];
					const v = view({
						sort: { column, direction },
						propertyFilters: filters,
						filter: round % 3 === 0 ? "n1" : "",
					});
					expect(
						applyDocumentTableView(rows, v, null, fields).map(
							(row) => row.path,
						),
					).toEqual(
						evaluateDocumentRowsForTest(rows, v, fields).map((row) => row.path),
					);
				}
			}
		}
	});
});

describe("CLI/MCP text filter values on typed front matter (QA3 #1)", () => {
	const b = (value: boolean): ScannedFrontMatterProperty => ({
		type: "checkbox",
		value,
	});
	const TYPED: Record<string, Props> = {
		"/ws/a.md": { done: b(true), priority: n(3) },
		"/ws/b.md": { done: b(false), priority: n(1) },
		"/ws/c.md": { done: b(true), priority: n(3) },
		"/ws/d.md": {},
	};
	const is = (key: string, value: string | number | boolean): PropertyFilter => ({
		fieldId: `prop:${key}`,
		kind: "is",
		value,
	});

	it("done=true / priority=3 from the CLI match the same rows as the app's typed chips", () => {
		const { rows, fields } = setup(TYPED);
		const match = (filter: PropertyFilter) =>
			names(rows, view({ propertyFilters: [filter] }), fields).sort();
		expect(match(is("done", true))).toEqual(["a", "c"]);
		expect(match(is("done", "true"))).toEqual(match(is("done", true)));
		expect(match(is("done", "false"))).toEqual(["b"]);
		expect(match(is("priority", 3))).toEqual(["a", "c"]);
		expect(match(is("priority", "3"))).toEqual(match(is("priority", 3)));
	});
});

describe("group by property (table-core groupBy)", () => {
	it("groups a select in value order, the empty group last", () => {
		const { rows, fields } = setup();
		const tree = buildPropertyGroupTree(rows, "prop:status", fields);
		expect(
			tree.children.map((group) => [
				group.label,
				group.ownPaths.length,
				group.isFallback,
			]),
		).toEqual([
			["Done", 1, false],
			["Todo", 2, false],
			["No status", 1, true],
		]);
	});

	it("lists a multi-tag document under each tag", () => {
		const { rows, fields } = setup();
		const tree = buildPropertyGroupTree(rows, "prop:tags", fields);
		expect(
			tree.children.map((group) => [group.label, [...group.members].sort()]),
		).toEqual([
			["home", ["/ws/b.md"]],
			["work", ["/ws/a.md", "/ws/b.md"]],
			["No tags", ["/ws/c.md", "/ws/d.md"]],
		]);
	});

	it("keeps the caller's row order inside a group", () => {
		const { rows, fields } = setup();
		const sorted = applyDocumentTableView(
			rows,
			view({ sort: { column: "name", direction: "desc" } }),
			null,
			fields,
		);
		const todo = buildPropertyGroupTree(
			sorted,
			"prop:status",
			fields,
		).children.find((group) => group.label === "Todo");
		expect(todo?.ownPaths).toEqual(["/ws/c.md", "/ws/a.md"]);
	});
});

describe("folder:<path> filter (saved views R7-R10)", () => {
	const FOLDER_PROPS: Record<string, Props> = {
		"/ws/AptusFit/a.md": { status: t("Todo") },
		"/ws/AptusFit/x/y/b.md": {},
		"/ws/AptusFitOld/c.md": { status: t("Todo") },
		"/ws/AptusFit.md": {},
		"/ws/other/d.md": {},
		"/ws/My Notes/e.md": {},
		"/ws/Café/f.md": {},
	};
	const folder = (path: string): PropertyFilter => ({ kind: "folder", path });
	const both = (
		rows: ReturnType<typeof setup>["rows"],
		v: DocumentTableView,
		fields: ReturnType<typeof setup>["fields"],
	) => {
		const fast = names(rows, v, fields).sort();
		const reference = evaluateDocumentRowsForTest(rows, v, fields)
			.map((row) => row.name)
			.sort();
		expect(fast).toEqual(reference);
		return fast;
	};

	it("matches the folder and every subfolder, never a prefix sibling or same-named root file", () => {
		const { rows, fields } = setup(FOLDER_PROPS);
		expect(
			both(rows, view({ propertyFilters: [folder("AptusFit")] }), fields),
		).toEqual(["a", "b"]);
		expect(
			both(rows, view({ propertyFilters: [folder("aptusfit/")] }), fields),
		).toEqual(["a", "b"]);
		expect(
			both(rows, view({ propertyFilters: [folder("AptusFit/x")] }), fields),
		).toEqual(["b"]);
	});

	it("spaces and NFC/NFD both match; empty, missing and escaping paths give zero rows", () => {
		const { rows, fields } = setup(FOLDER_PROPS);
		expect(
			both(rows, view({ propertyFilters: [folder("My Notes")] }), fields),
		).toEqual(["e"]);
		expect(
			both(rows, view({ propertyFilters: [folder("Café")] }), fields),
		).toEqual(["f"]);
		for (const bad of ["", "Nope", "..", "/ws", "~", "AptusFit/../.."]) {
			expect(
				both(rows, view({ propertyFilters: [folder(bad)] }), fields),
			).toEqual([]);
		}
	});

	it("is AND-ed with has/is chips and the name box", () => {
		const { rows, fields } = setup(FOLDER_PROPS);
		const has: PropertyFilter = { fieldId: "prop:status", kind: "has" };
		expect(
			both(rows, view({ propertyFilters: [folder("AptusFit"), has] }), fields),
		).toEqual(["a"]);
		expect(
			both(
				rows,
				view({ filter: "b", propertyFilters: [folder("AptusFit")] }),
				fields,
			),
		).toEqual(["b"]);
	});

	it("updates live when a file moves into or out of the folder (new listing)", () => {
		const v = view({ propertyFilters: [folder("AptusFit")] });
		const before = setup(FOLDER_PROPS);
		expect(names(before.rows, v, before.fields).sort()).toEqual(["a", "b"]);
		const moved = { ...FOLDER_PROPS };
		delete moved["/ws/AptusFit/a.md"];
		moved["/ws/other/a.md"] = {};
		moved["/ws/AptusFit/d2.md"] = {};
		const after = setup(moved);
		expect(names(after.rows, v, after.fields).sort()).toEqual(["b", "d2"]);
	});

	it("a view whose folder chip points nowhere still loads with the chip kept (R8)", () => {
		const loaded = sanitizeDocumentViews({
			"/ws": {
				saved: [
					{
						id: "v",
						name: "Gone",
						filters: [
							{ kind: "folder", path: "Deleted/Folder" },
							{ kind: "folder" },
						],
					},
				],
			},
		});
		expect(loaded["/ws"].saved[0].filters).toEqual([
			{ kind: "folder", path: "Deleted/Folder" },
		]);
	});

	it("has/is results are unchanged when no folder chip is present (R9)", () => {
		const { rows, fields } = setup();
		const has: PropertyFilter = { fieldId: "prop:priority", kind: "has" };
		expect(names(rows, view({ propertyFilters: [has] }), fields)).toEqual([
			"b",
			"a",
		]);
	});
});
