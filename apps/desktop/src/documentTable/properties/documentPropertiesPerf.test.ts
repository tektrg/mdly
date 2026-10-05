import { describe, expect, it } from "vitest";
import type { ScannedFrontMatterProperty } from "../../desktopApi/types";
import {
	applyDocumentTableView,
	buildDocumentRows,
	createDefaultDocumentTableView,
	resetDocumentRowsMemo,
	withPropertyValues,
} from "../documentTableView";
import { derivePropertyModel } from "./propertyFields";
import { buildPropertyGroupTree } from "./propertyGroupTree";

const FILE_COUNT = 50_000;
const STATUSES = ["Todo", "Doing", "Done", "Blocked"];

function timed<T>(label: string, run: () => T): { value: T; ms: number } {
	const start = performance.now();
	const value = run();
	const ms = performance.now() - start;
	console.info(`[perf 50k] ${label}: ${ms.toFixed(1)} ms`);
	return { value, ms };
}

/**
 * Not a micro-benchmark: a guard that the renderer-side work per scan batch
 * and per keystroke stays in the budget the design note sets (filter/sort a
 * 50k view < 50 ms to first paint, where the keystroke is the hot path).
 * Bounds are loose (CI machines vary); the logged numbers are the record.
 */
describe("property columns at 50k documents", () => {
	it("infers, merges, sorts, filters and groups within budget", () => {
		resetDocumentRowsMemo();
		const files = Array.from({ length: FILE_COUNT }, (_, index) => ({
			path: `/ws/folder-${index % 200}/note-${index}.md`,
			modified_at: 1_700_000_000 + index,
		}));
		const propertiesByPath: Record<
			string,
			Record<string, ScannedFrontMatterProperty>
		> = {};
		files.forEach((file, index) => {
			const properties: Record<string, ScannedFrontMatterProperty> = {
				status: { type: "text", value: STATUSES[index % 4] },
				tags: { type: "tags", value: [`t${index % 30}`, `t${index % 7}`] },
			};
			// Sparse property (decision E's example: 300 of 50k carry a due date).
			if (index % 166 === 0) {
				properties.due = { type: "date", value: "2026-10-05" };
			}
			if (index % 3 === 0) {
				properties.priority = { type: "number", value: index % 5 };
			}
			propertiesByPath[file.path] = properties;
		});

		const model = timed("infer schema + typed values (per scan batch)", () =>
			derivePropertyModel(propertiesByPath),
		).value;
		const rows = buildDocumentRows(files, "/ws");
		const merged = timed("merge values into rows (per scan batch)", () =>
			withPropertyValues(rows, model.valuesByPath),
		).value;

		const base = {
			...createDefaultDocumentTableView(),
			sort: { column: "prop:priority" as const, direction: "desc" as const },
		};
		timed("sort by property (per sort change)", () =>
			applyDocumentTableView(merged, base, null, model.fields),
		);
		const chips = {
			...base,
			propertyFilters: [{ fieldId: "prop:due" as const, kind: "has" as const }],
		};
		const chipped = timed("add `has due` chip (per chip change)", () =>
			applyDocumentTableView(merged, chips, null, model.fields),
		).value;
		expect(chipped).toHaveLength(Math.ceil(FILE_COUNT / 166));

		const keystroke = timed("keystroke with sort + chip active", () =>
			applyDocumentTableView(
				merged,
				{ ...chips, filter: "note-1" },
				null,
				model.fields,
			),
		);
		const sorted = applyDocumentTableView(merged, base, null, model.fields);
		const grouped = timed("group by status", () =>
			buildPropertyGroupTree(sorted, "prop:status", model.fields),
		);
		const groupedTags = timed("group by tags (multi-membership)", () =>
			buildPropertyGroupTree(sorted, "prop:tags", model.fields),
		);
		expect(grouped.value.children).toHaveLength(4);
		expect(groupedTags.value.children.length).toBeGreaterThan(20);
		expect(keystroke.ms).toBeLessThan(50);
	});
});
