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
import type { PropertyFilter } from "./documentViews";
import { buildPropertyGroupTree } from "./propertyGroupTree";
import { derivePropertyModel } from "./propertyFields";

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
			names(rows, view({ sort: { column: "prop:priority", direction: "asc" } }), fields),
		).toEqual(["b", "a", "c", "d"]);
		expect(
			names(rows, view({ sort: { column: "prop:priority", direction: "desc" } }), fields),
		).toEqual(["a", "b", "c", "d"]);
	});

	it("falls back to the default sort for a property no document has", () => {
		const { rows, fields } = setup();
		expect(
			names(rows, view({ sort: { column: "prop:gone", direction: "asc" } }), fields),
		).toEqual(["d", "c", "b", "a"]);
	});

	it("filters with has / is / tag chips, AND-ed, and keeps the sort", () => {
		const { rows, fields } = setup();
		const has: PropertyFilter = { fieldId: "prop:priority", kind: "has" };
		const todo: PropertyFilter = { fieldId: "prop:status", kind: "is", value: "Todo" };
		const home: PropertyFilter = { fieldId: "prop:tags", kind: "is", value: "home" };
		expect(names(rows, view({ propertyFilters: [has] }), fields)).toEqual(["b", "a"]);
		expect(names(rows, view({ propertyFilters: [has, todo] }), fields)).toEqual(["a"]);
		expect(names(rows, view({ propertyFilters: [home] }), fields)).toEqual(["b"]);
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
				view({ filter: "c", propertyFilters: [{ fieldId: "prop:status", kind: "has" }] }),
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
				if (random() < 0.7) entry.status = t(statuses[Math.floor(random() * 4)]);
				if (random() < 0.5) entry.priority = n(Math.floor(random() * 4));
				props[`/ws/n${index}.md`] = entry;
			}
			const { rows, fields } = setup(props);
			for (const column of ["prop:status", "prop:priority", "name"] as const) {
				for (const direction of ["asc", "desc"] as const) {
					const filters: PropertyFilter[] =
						round % 2 === 0 ? [{ fieldId: "prop:priority", kind: "has" }] : [];
					const v = view({ sort: { column, direction }, propertyFilters: filters, filter: round % 3 === 0 ? "n1" : "" });
					expect(
						applyDocumentTableView(rows, v, null, fields).map((row) => row.path),
					).toEqual(
						evaluateDocumentRowsForTest(rows, v, fields).map((row) => row.path),
					);
				}
			}
		}
	});
});

describe("group by property (table-core groupBy)", () => {
	it("groups a select in value order, the empty group last", () => {
		const { rows, fields } = setup();
		const tree = buildPropertyGroupTree(rows, "prop:status", fields);
		expect(
			tree.children.map((group) => [group.label, group.ownPaths.length, group.isFallback]),
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
		const todo = buildPropertyGroupTree(sorted, "prop:status", fields).children.find(
			(group) => group.label === "Todo",
		);
		expect(todo?.ownPaths).toEqual(["/ws/c.md", "/ws/a.md"]);
	});
});
