import { describe, expect, it } from "vitest";
import {
	buildNotionLinkedMarkdown,
	buildNotionLinkedMarkdownFromMetadata,
	parseNotionLinkMetadata,
	stripNotionLinkMetadata,
	uniqueNotionMarkdownPath,
} from "./notionMarkdown";

const notionPage = {
	id: "page-id",
	object: "page" as const,
	account: "7lab",
	title: "Roadmap / Q3",
	url: "https://notion.so/page-id",
	lastEditedTime: "2026-06-25T00:00:00.000Z",
};

describe("buildNotionLinkedMarkdown", () => {
	it("merges notion metadata into existing frontmatter", () => {
		const markdown = "---\nStatus: Draft\n---\n# Roadmap\n";

		expect(
			buildNotionLinkedMarkdown(markdown, {
				result: notionPage,
				contentHash: "abc123",
			}),
		).toBe(
			[
				"---",
				"Status: Draft",
				"notion:",
				'  object: "page"',
				'  page_id: "page-id"',
				'  account: "7lab"',
				'  url: "https://notion.so/page-id"',
				'  title: "Roadmap / Q3"',
				'  last_edited_time: "2026-06-25T00:00:00.000Z"',
				'  content_hash: "abc123"',
				'  sync: "linked"',
				"---",
				"# Roadmap\n",
			].join("\n"),
		);
	});

	it("creates frontmatter when the markdown body has none", () => {
		const linked = buildNotionLinkedMarkdown("# Roadmap\n", {
			result: notionPage,
			contentHash: "abc123",
		});

		expect(linked).toContain('page_id: "page-id"');
		expect(linked).toContain("# Roadmap");
	});

	it("replaces existing notion metadata instead of duplicating it", () => {
		const linked = buildNotionLinkedMarkdownFromMetadata(
			buildNotionLinkedMarkdown("# Roadmap\n", {
				result: notionPage,
				contentHash: "old-hash",
			}),
			{
				object: "page",
				pageId: "page-id",
				account: "7lab",
				url: "https://notion.so/page-id",
				title: "Roadmap / Q3",
				lastEditedTime: "2026-06-25T00:00:00.000Z",
				contentHash: "new-hash",
				sync: "linked",
			},
		);

		expect(linked.match(/^notion:/gm)).toHaveLength(1);
		expect(linked).toContain('content_hash: "new-hash"');
		expect(linked).not.toContain("old-hash");
	});
});

describe("parseNotionLinkMetadata", () => {
	it("reads Hubble notion frontmatter metadata", () => {
		const linked = buildNotionLinkedMarkdown("# Roadmap\n", {
			result: notionPage,
			contentHash: "abc123",
		});

		expect(parseNotionLinkMetadata(linked)).toEqual({
			object: "page",
			pageId: "page-id",
			account: "7lab",
			url: "https://notion.so/page-id",
			title: "Roadmap / Q3",
			lastEditedTime: "2026-06-25T00:00:00.000Z",
			contentHash: "abc123",
			sync: "linked",
		});
	});
});

describe("stripNotionLinkMetadata", () => {
	it("removes Hubble notion metadata before pushing content to Notion", () => {
		const linked = buildNotionLinkedMarkdown(
			"---\nStatus: Draft\n---\n# Roadmap\n",
			{
				result: notionPage,
				contentHash: "abc123",
			},
		);

		expect(stripNotionLinkMetadata(linked)).toBe(
			"---\nStatus: Draft\n---\n# Roadmap\n",
		);
	});
});

describe("uniqueNotionMarkdownPath", () => {
	it("creates a safe unique path in the target folder", () => {
		expect(
			uniqueNotionMarkdownPath({
				folderPath: "/workspace/notes",
				title: "Roadmap / Q3",
				existingPaths: ["/workspace/notes/Roadmap - Q3.md"],
			}),
		).toBe("/workspace/notes/Roadmap - Q3-2.md");
	});
});
