// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

vi.mock("../properties/propertyWrite", () => ({
	writeDocumentProperty: vi.fn(),
}));
vi.mock("../../store/actions", () => ({}));

import type { DocumentTableRow } from "../documentTableView";
import type { PropertyField } from "../properties/propertyFields";
import { moveBoardCard } from "./boardActions";

const field: PropertyField = {
	id: "prop:status",
	label: "Status",
	type: "multiSelect",
	documentCount: 1,
};
const row = {
	path: "/ws/a.md",
	openPath: "/ws/a.md",
	name: "a",
	properties: { "prop:status": ["todo", "urgent"] },
} as unknown as DocumentTableRow;

describe("moveBoardCard", () => {
	it("rewrites only the source value, then Undo restores the original list", async () => {
		const write = vi.fn().mockResolvedValue({ ok: true, changed: true });
		let undo: (() => void) | null = null;
		const notify = {
			moved: (_: string, fn: () => void) => {
				undo = fn;
			},
			failed: vi.fn(),
		};
		const ok = await moveBoardCard(
			{
				row,
				title: "A",
				field,
				from: { kind: "value", value: "todo" },
				to: { kind: "value", value: "done", label: "done" },
			},
			write,
			notify,
		);
		expect(ok).toBe(true);
		expect(write).toHaveBeenLastCalledWith(row, "Status", ["done", "urgent"]);
		expect(undo).not.toBeNull();
		(undo as unknown as () => void)();
		expect(write).toHaveBeenLastCalledWith(row, "Status", ["todo", "urgent"]);
	});

	it("reports a refusal and offers no undo", async () => {
		const write = vi.fn().mockResolvedValue({ ok: false, reason: "unsaved" });
		const notify = { moved: vi.fn(), failed: vi.fn() };
		const ok = await moveBoardCard(
			{
				row,
				title: "A",
				field,
				from: { kind: "value", value: "todo" },
				to: { kind: "empty", value: null, label: "No Status" },
			},
			write,
			notify,
		);
		expect(ok).toBe(false);
		expect(notify.moved).not.toHaveBeenCalled();
		expect(notify.failed).toHaveBeenCalledWith(
			"“A” was not changed",
			"unsaved",
		);
	});
});
