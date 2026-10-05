import { describe, expect, it } from "vitest";
import type { DocumentTableRow } from "../documentTableView";
import type { PropertyField } from "../properties/propertyFields";
import { BOARD_COLUMN_CARD_LIMIT, buildBoardModel } from "./boardModel";
import { buildCalendarModel } from "./calendarModel";

const CARD_COUNT = 5000;
const STATUSES = ["Todo", "Doing", "Done", "Blocked"];

const STATUS: PropertyField = {
	id: "prop:status",
	label: "status",
	type: "select",
	options: STATUSES,
	documentCount: CARD_COUNT,
};
const DUE: PropertyField = {
	id: "prop:due",
	label: "due",
	type: "date",
	documentCount: CARD_COUNT,
};

function rows(): DocumentTableRow[] {
	return Array.from({ length: CARD_COUNT }, (_, index) => {
		const path = `/ws/note-${index}.md`;
		const day = String((index % 28) + 1).padStart(2, "0");
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
			properties:
				index % 10 === 0
					? {}
					: {
							"prop:status": STATUSES[index % STATUSES.length] as string,
							"prop:due": `2026-10-${day}`,
						},
		};
	});
}

function timed<T>(label: string, run: () => T): { value: T; ms: number } {
	const start = performance.now();
	const value = run();
	const ms = performance.now() - start;
	console.info(`[perf 5k] ${label}: ${ms.toFixed(2)} ms`);
	return { value, ms };
}

describe("board and calendar at 5k notes", () => {
	it("builds render models within budget, with a bounded card count", () => {
		const input = rows();
		const board = timed("board model", () => buildBoardModel(input, STATUS));
		const rendered = board.value.columns.reduce(
			(sum, column) => sum + column.rows.length,
			0,
		);
		const total = board.value.columns.reduce(
			(sum, column) => sum + column.total,
			0,
		);
		expect(total).toBe(CARD_COUNT);
		expect(rendered).toBeLessThanOrEqual(
			board.value.columns.length * BOARD_COLUMN_CARD_LIMIT,
		);
		console.info(`[perf 5k] board cards rendered: ${rendered} of ${total}`);
		const calendar = timed("calendar model", () =>
			buildCalendarModel(input, DUE, { year: 2026, month: 9 }),
		);
		expect(calendar.value.undatedCount).toBe(CARD_COUNT / 10);
		// Loose bounds (CI machines vary); the logged numbers are the record.
		expect(board.ms).toBeLessThan(50);
		expect(calendar.ms).toBeLessThan(50);
	});
});
