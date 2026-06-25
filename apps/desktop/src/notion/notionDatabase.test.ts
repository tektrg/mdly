import { describe, expect, it } from "vitest";
import {
	buildNotionDatabaseMarkdown,
	parseNotionDatabaseMetadata,
} from "./notionDatabase";

const databaseResult = {
	id: "source-id",
	object: "data_source" as const,
	account: "7lab",
	title: "Roadmap",
	url: "https://notion.so/source-id",
	lastEditedTime: "2026-06-25T00:00:00.000Z",
};

describe("buildNotionDatabaseMarkdown", () => {
	it("creates read-only database metadata and a markdown table snapshot", () => {
		const markdown = buildNotionDatabaseMarkdown({
			result: databaseResult,
			pageSize: 25,
			query: {
				sourceId: "resolved-source-id",
				columns: ["Status", "Notes"],
				hasMore: true,
				nextCursor: "cursor-2",
				rows: [
					{
						pageId: "page-1",
						title: "First row",
						url: "https://notion.so/page-1",
						lastEditedTime: "2026-06-25T00:00:00.000Z",
						properties: {
							Status: "Active",
							Notes: "Contains | pipe",
						},
					},
				],
			},
		});

		expect(parseNotionDatabaseMetadata(markdown)).toEqual({
			object: "data_source",
			sourceId: "resolved-source-id",
			account: "7lab",
			url: "https://notion.so/source-id",
			title: "Roadmap",
			sync: "read_only",
			pageSize: 25,
		});
		expect(markdown).toContain("| Row | Status | Notes |");
		expect(markdown).toContain("| First row | Active | Contains \\| pipe |");
	});
});

describe("parseNotionDatabaseMetadata", () => {
	it("ignores page link metadata", () => {
		expect(
			parseNotionDatabaseMetadata(
				[
					"---",
					"notion:",
					'  object: "page"',
					'  sync: "linked"',
					"---",
					"# Page",
				].join("\n"),
			),
		).toBeNull();
	});
});
