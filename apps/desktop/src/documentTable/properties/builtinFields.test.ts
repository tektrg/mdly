import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyDocumentTableView,
	buildDocumentRows,
	createDefaultDocumentTableView,
	resetDocumentRowsMemo,
	withPropertyValues,
} from "../documentTableView";
import {
	BUILTIN_FIELD_IDS,
	formatFileSize,
	localDateTime,
	READ_ONLY_MOVE_MESSAGE,
	viewUsesFileStats,
} from "./builtinFields";
import { sanitizeDocumentViews } from "./documentViews";
import {
	derivePropertyModel,
	formatPropertyValue,
	isPropertyFieldId,
	propertyFieldId,
} from "./propertyFields";
import { buildPropertyGroupTree } from "./propertyGroupTree";

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));
const writeDocumentProperty = vi.fn(async () => ({ ok: true, changed: true }));
vi.mock("./propertyWrite", () => ({
	writeDocumentProperty: () => writeDocumentProperty(),
}));

const SECONDS = (iso: string) => Date.parse(iso) / 1000;

function workspace() {
	resetDocumentRowsMemo();
	const files = [
		{ path: "/ws/a.md", modified_at: SECONDS("2026-10-05T10:00:00"), created_at: SECONDS("2026-01-02T08:00:00") },
		{ path: "/ws/notes/b.md", modified_at: SECONDS("2026-10-04T23:30:00"), created_at: SECONDS("2025-06-01T08:00:00") },
		{ path: "/ws/notes/c.md", modified_at: SECONDS("2026-09-01T09:00:00") },
	];
	const rows = buildDocumentRows(files, "/ws");
	const propertiesByPath = {
		"/ws/a.md": { created: { type: "date" as const, value: "2020-01-01" } },
	};
	const statsByPath = {
		"/ws/a.md": { sizeBytes: 12_400, wordCount: 1200 },
		"/ws/notes/b.md": { sizeBytes: 300, wordCount: 40 },
	};
	const model = derivePropertyModel(propertiesByPath, { rows, statsByPath });
	return { rows, model, merged: withPropertyValues(rows, model.valuesByPath) };
}

beforeEach(() => {
	toastError.mockClear();
	writeDocumentProperty.mockClear();
});

describe("built-in fields", () => {
	it("lists the five built-ins after front matter, read-only, with distinct labels", () => {
		const { model } = workspace();
		expect(model.fields.map((field) => [field.id, field.label, field.type])).toEqual([
			["prop:created", "created", "date"],
			["file:modified", "Modified", "date"],
			["file:created", "Created (file)", "date"],
			["file:folder", "Folder", "select"],
			["file:words", "Word count", "number"],
			["file:size", "Size", "number"],
		]);
		expect(model.fields.filter((field) => field.readOnly)).toHaveLength(5);
		const folder = model.fields.find((field) => field.id === BUILTIN_FIELD_IDS.folder);
		expect(folder?.options).toEqual(["notes", "—"]);
		expect(model.fields.find((field) => field.id === "file:words")?.documentCount).toBe(2);
	});

	it("keeps a front-matter `created` separate from the file's", () => {
		const { model } = workspace();
		const values = model.valuesByPath.get("/ws/a.md");
		expect(values?.["prop:created"]).toBe("2020-01-01");
		expect(values?.["file:created"]).toBe("2026-01-02T08:00:00");
		expect(values?.["file:modified"]).toBe("2026-10-05T10:00:00");
		expect(values?.["file:folder"]).toBe("—");
		expect(values?.["file:size"]).toBe(12_400);
		// Not counted yet: no value, not zero.
		expect(model.valuesByPath.get("/ws/notes/c.md")?.["file:words"]).toBeUndefined();
	});

	it("ids are reserved: `file:` ids are known built-ins only, never a front-matter id", () => {
		expect(isPropertyFieldId("file:modified")).toBe(true);
		expect(isPropertyFieldId("file:nope")).toBe(false);
		expect(propertyFieldId("file:modified")).toBe("prop:file:modified");
	});

	it("filters, sorts and groups like any property", () => {
		const { merged, model } = workspace();
		const view = {
			...createDefaultDocumentTableView(),
			sort: { column: BUILTIN_FIELD_IDS.wordCount, direction: "desc" as const },
			propertyFilters: [{ fieldId: BUILTIN_FIELD_IDS.folder, kind: "is" as const, value: "notes" }],
		};
		expect(applyDocumentTableView(merged, view, null, model.fields).map((row) => row.name)).toEqual(["b", "c"]);
		const tree = buildPropertyGroupTree(merged, BUILTIN_FIELD_IDS.folder, model.fields);
		expect(tree.children.map((group) => [group.label, group.ownPaths.length])).toEqual([["notes", 2], ["—", 1]]);
	});

	it("groups any date field into relative ranges by local day", () => {
		const { merged, model } = workspace();
		const now = new Date("2026-10-05T18:00:00");
		const byModified = buildPropertyGroupTree(merged, BUILTIN_FIELD_IDS.modified, model.fields, now);
		expect(byModified.children.map((group) => group.label)).toEqual(["Today", "Yesterday", "Earlier this year"]);
		const byFrontMatter = buildPropertyGroupTree(merged, "prop:created", model.fields, now);
		expect(byFrontMatter.children.map((group) => [group.label, group.ownPaths.length])).toEqual([["Older", 1], ["No date", 2]]);
	});

	it("formats sizes, counts and date-times", () => {
		expect(formatFileSize(820)).toBe("820 B");
		expect(formatFileSize(12_400)).toBe("12 KB");
		expect(formatFileSize(3_500_000)).toBe("3.3 MB");
		expect(formatPropertyValue(1536, "file:size")).toBe("1.5 KB");
		expect(formatPropertyValue("2026-10-05T10:00:00", "file:modified")).toBe("2026-10-05 10:00");
		expect(formatPropertyValue(1536, "prop:size")).toBe("1536");
		expect(localDateTime(SECONDS("2026-03-04T05:06:07"))).toBe("2026-03-04T05:06:07");
	});

	it("counts words only while the view uses Size or Word count", () => {
		const base = { propertyColumns: [], sortColumn: "modified", filterFieldIds: [], groupBy: null };
		expect(viewUsesFileStats(base)).toBe(false);
		expect(viewUsesFileStats({ ...base, propertyColumns: ["file:modified"] })).toBe(false);
		expect(viewUsesFileStats({ ...base, propertyColumns: ["file:words"] })).toBe(true);
		expect(viewUsesFileStats({ ...base, sortColumn: "file:size" })).toBe(true);
		expect(viewUsesFileStats({ ...base, groupBy: "file:size" })).toBe(true);
	});
});

describe("read-only moves", () => {
	it("a drop on a built-in writes nothing and says why", async () => {
		const { writeDroppedProperty } = await import("../views/viewDrag");
		const { merged, model } = workspace();
		const folder = model.fields.find((field) => field.id === BUILTIN_FIELD_IDS.folder);
		if (!folder || !merged[0]) throw new Error("fixture");
		expect(await writeDroppedProperty(merged[0], folder, "notes")).toBe(false);
		expect(writeDocumentProperty).not.toHaveBeenCalled();
		expect(toastError).toHaveBeenCalledWith(READ_ONLY_MOVE_MESSAGE);
	});
});

describe("saved views persistence", () => {
	it("keeps built-in ids, drops unknown `file:` ids, and leaves old views unchanged", () => {
		const stored = {
			"/ws": {
				propertyColumns: ["file:words", "file:bogus", "prop:status"],
				saved: [
					{
						id: "v1", name: "Recent", viewType: "board", boardField: "file:folder", calendarField: "file:modified",
						sort: { column: "file:size", direction: "desc" }, groupBy: "file:modified",
						filters: [{ fieldId: "file:folder", kind: "is", value: "notes" }, { fieldId: "file:x", kind: "has" }],
						propertyColumns: ["file:created"],
					},
					{ id: "old", name: "Old", sort: { column: "modified", direction: "desc" }, filters: [], groupBy: "prop:status", propertyColumns: [] },
				],
			},
		};
		const sanitized = sanitizeDocumentViews(stored)["/ws"];
		expect(sanitized?.propertyColumns).toEqual(["file:words", "prop:status"]);
		expect(sanitized?.saved[0]).toMatchObject({
			boardField: "file:folder", calendarField: "file:modified", groupBy: "file:modified",
			sort: { column: "file:size", direction: "desc" },
			filters: [{ fieldId: "file:folder", kind: "is", value: "notes" }],
			propertyColumns: ["file:created"],
		});
		expect(sanitized?.saved[1]).toMatchObject({ viewType: "table", boardField: null, groupBy: "prop:status" });
	});
});
