import { describe, expect, it } from "vitest";
import { notionBrowserUrlForMarkdown } from "./notionBrowserUrl";
import { buildNotionDatabaseMarkdown } from "./notionDatabase";
import { buildNotionLinkedMarkdown } from "./notionMarkdown";

const notionPage = {
	id: "page-id",
	object: "page" as const,
	account: "7lab",
	title: "Roadmap",
	url: "https://notion.so/page-id",
	lastEditedTime: "2026-06-25T00:00:00.000Z",
};

const notionDatabase = {
	id: "database-id",
	object: "data_source" as const,
	account: "7lab",
	title: "Roadmap database",
	url: "https://notion.so/database-id",
	lastEditedTime: "2026-06-25T00:00:00.000Z",
};

describe("notionBrowserUrlForMarkdown", () => {
	it("returns the stored browser URL for linked Notion pages", () => {
		const markdown = buildNotionLinkedMarkdown("# Roadmap\n", {
			result: notionPage,
			contentHash: "abc123",
		});

		expect(notionBrowserUrlForMarkdown(markdown)).toBe(
			"https://notion.so/page-id",
		);
	});

	it("returns the stored browser URL for imported Notion databases", () => {
		const markdown = buildNotionDatabaseMarkdown({
			result: notionDatabase,
			pageSize: 25,
			query: {
				sourceId: "resolved-source-id",
				columns: [],
				rows: [],
				hasMore: false,
				nextCursor: null,
			},
		});

		expect(notionBrowserUrlForMarkdown(markdown)).toBe(
			"https://notion.so/database-id",
		);
	});

	it("returns null when the linked Notion file has no saved URL", () => {
		const markdown = buildNotionLinkedMarkdown("# Roadmap\n", {
			result: { ...notionPage, url: null },
			contentHash: "abc123",
		});

		expect(notionBrowserUrlForMarkdown(markdown)).toBeNull();
	});
});
