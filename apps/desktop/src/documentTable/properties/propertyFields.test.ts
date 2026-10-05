import { describe, expect, it } from "vitest";
import type { ScannedFrontMatterProperty } from "../../desktopApi/types";
import {
	buildPropertyRowValues,
	formatPropertyValue,
	inferPropertyFields,
	isPropertyFieldId,
	type PropertiesByPath,
	propertyFieldId,
} from "./propertyFields";

const text = (value: string): ScannedFrontMatterProperty => ({
	type: "text",
	value,
});

function fieldById(byPath: PropertiesByPath, id: string) {
	return inferPropertyFields(byPath).find((field) => field.id === id);
}

describe("inferPropertyFields", () => {
	it("types numbers, dates and checkboxes from the editor's own value types", () => {
		const byPath: PropertiesByPath = {
			"/a.md": {
				priority: { type: "number", value: 2 },
				due: { type: "date", value: "2026-10-01" },
				done: { type: "checkbox", value: true },
			},
			"/b.md": {
				priority: { type: "number", value: 1 },
				due: { type: "date", value: "2026-09-01" },
				done: { type: "checkbox", value: false },
			},
		};
		expect(fieldById(byPath, "prop:priority")?.type).toBe("number");
		expect(fieldById(byPath, "prop:due")?.type).toBe("date");
		expect(fieldById(byPath, "prop:done")?.type).toBe("boolean");
	});

	it("reads repeated short text as a select, unique text as text", () => {
		const byPath: PropertiesByPath = {
			"/a.md": { status: text("Todo"), title: text("Alpha") },
			"/b.md": { status: text("Done"), title: text("Beta") },
			"/c.md": { status: text("Todo"), title: text("Gamma") },
		};
		const status = fieldById(byPath, "prop:status");
		expect(status?.type).toBe("select");
		expect(status?.options).toEqual(["Todo", "Done"]);
		expect(fieldById(byPath, "prop:title")?.type).toBe("text");
	});

	it("treats a scalar `tags: work` next to a list as one multiSelect", () => {
		const byPath: PropertiesByPath = {
			"/a.md": { tags: { type: "tags", value: ["work", "ideas"] } },
			"/b.md": { tags: text("work") },
		};
		const tags = fieldById(byPath, "prop:tags");
		expect(tags?.type).toBe("multiSelect");
		const values = buildPropertyRowValues(byPath, tags ? [tags] : []);
		expect(values.get("/b.md")).toEqual({ "prop:tags": ["work"] });
	});

	it("falls back to text for mixed scalar types, never guessing", () => {
		const byPath: PropertiesByPath = {
			"/a.md": { size: { type: "number", value: 3 } },
			"/b.md": { size: text("large") },
		};
		const size = fieldById(byPath, "prop:size");
		expect(size?.type).toBe("text");
		expect(
			buildPropertyRowValues(byPath, size ? [size] : []).get("/a.md"),
		).toEqual({ "prop:size": "3" });
	});

	it("merges keys case-insensitively, labels with the commonest spelling, counts non-empty only", () => {
		const byPath: PropertiesByPath = {
			"/a.md": { Status: text("x") },
			"/b.md": { status: text("y") },
			"/c.md": { status: text("y") },
			"/d.md": { status: text("  ") },
		};
		const fields = inferPropertyFields(byPath);
		expect(fields).toHaveLength(1);
		expect(fields[0]).toMatchObject({
			id: "prop:status",
			label: "status",
			documentCount: 3,
		});
	});

	it("counts a document once when it repeats a key in another case", () => {
		const byPath: PropertiesByPath = {
			"/a.md": { Status: text("x"), status: text("y") },
		};
		expect(inferPropertyFields(byPath)[0]?.documentCount).toBe(1);
	});

	it("orders fields by document count", () => {
		const byPath: PropertiesByPath = {
			"/a.md": { rare: text("1"), common: text("a") },
			"/b.md": { common: text("b") },
		};
		expect(inferPropertyFields(byPath).map((field) => field.id)).toEqual([
			"prop:common",
			"prop:rare",
		]);
	});
});

describe("property ids and formatting", () => {
	it("namespaces ids and rejects bare prefixes", () => {
		expect(propertyFieldId(" Due Date ")).toBe("prop:due date");
		expect(isPropertyFieldId("prop:x")).toBe(true);
		expect(isPropertyFieldId("prop:")).toBe(false);
		expect(isPropertyFieldId("name")).toBe(false);
	});

	it("formats cells, booleans as words", () => {
		expect(formatPropertyValue(["a", "b"])).toBe("a, b");
		expect(formatPropertyValue(false)).toBe("No");
		expect(formatPropertyValue(null)).toBe("");
		expect(formatPropertyValue(4)).toBe("4");
	});
});
