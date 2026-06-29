import { describe, expect, it } from "vitest";
import { notionMarkdownContentHash } from "./contentHash";
import {
	buildNotionLinkedMarkdown,
	buildNotionLinkedMarkdownFromMetadata,
	notionMarkdownBodyForUpdate,
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

	it("keeps the Notion content hash stable after wrapping and stripping metadata", () => {
		const remoteMarkdown = "---\nStatus: Draft\n---\n\n# Roadmap";
		const linked = buildNotionLinkedMarkdown(remoteMarkdown, {
			result: notionPage,
			contentHash: notionMarkdownContentHash(remoteMarkdown),
		});

		expect(notionMarkdownContentHash(stripNotionLinkMetadata(linked))).toBe(
			notionMarkdownContentHash(remoteMarkdown),
		);
	});

	it("treats a blank frontmatter-to-body separator as hash-equivalent", () => {
		const remoteMarkdown = [
			"---",
			"Status: Draft",
			"---",
			"",
			"<callout>",
			"\t**MVP focus**",
			"</callout>",
		].join("\n");
		const localMarkdown = remoteMarkdown.replace(
			"---\n\n<callout>",
			"---\n<callout>",
		);

		expect(notionMarkdownContentHash(localMarkdown)).toBe(
			notionMarkdownContentHash(remoteMarkdown),
		);

		const linked = buildNotionLinkedMarkdown(remoteMarkdown, {
			result: notionPage,
			contentHash: notionMarkdownContentHash(remoteMarkdown),
		});
		expect(notionMarkdownContentHash(stripNotionLinkMetadata(linked))).toBe(
			notionMarkdownContentHash(remoteMarkdown),
		);
	});

	it("treats Notion callout wrapper indentation as hash-equivalent", () => {
		const remoteMarkdown = [
			"---",
			"Status: Draft",
			"---",
			'<callout icon="/icons/checklist_blue.svg">',
			"\t**MVP focus**",
			"\tIndented detail",
			"</callout>",
		].join("\n");
		const editorMarkdown = remoteMarkdown
			.replace("\t**MVP focus**", "**MVP focus**")
			.replace("\tIndented detail", "Indented detail");

		expect(notionMarkdownContentHash(editorMarkdown)).toBe(
			notionMarkdownContentHash(remoteMarkdown),
		);
	});

	it("canonicalizes duplicated Notion frontmatter blocks before wrapping", () => {
		const remoteMarkdown = [
			"---",
			"AI Summary: First copy",
			"PIC: []",
			"---",
			"",
			"---",
			"AI Summary: Escaped duplicate copy",
			"PIC: \\[\\]",
			"---",
			"# Body",
		].join("\n");
		const linked = buildNotionLinkedMarkdown(remoteMarkdown, {
			result: notionPage,
			contentHash: notionMarkdownContentHash(remoteMarkdown),
		});
		const stripped = stripNotionLinkMetadata(linked);

		expect(linked.match(/^---$/gm)).toHaveLength(2);
		expect(stripped).toBe(
			["---", "AI Summary: First copy", "PIC: []", "---", "# Body"].join("\n"),
		);
		expect(notionMarkdownContentHash(stripped)).toBe(
			notionMarkdownContentHash(remoteMarkdown),
		);
	});

	it("separates Notion dividers from previous paragraphs before wrapping", () => {
		const remoteMarkdown = [
			"---",
			"title: Sprint note",
			"---",
			"Intro paragraph",
			"---",
			"## Next section",
		].join("\n");
		const linked = buildNotionLinkedMarkdown(remoteMarkdown, {
			result: notionPage,
			contentHash: notionMarkdownContentHash(remoteMarkdown),
		});
		const stripped = stripNotionLinkMetadata(linked);

		expect(stripped).toContain("Intro paragraph\n\n---\n## Next section");
		expect(notionMarkdownContentHash(stripped)).toBe(
			notionMarkdownContentHash(remoteMarkdown),
		);
	});

	it("keeps supported Notion HTML tables hash-equivalent to saved GFM tables", () => {
		const remoteMarkdown = [
			'<table header-row="true">',
			"<tr>",
			"<td>Item</td>",
			"<td>Status</td>",
			"<td>Action</td>",
			"</tr>",
			"<tr>",
			"<td>Trial days-left badge (`coach-trial-days-badge`)</td>",
			"<td>Exists</td>",
			'<td>Add inline **"i {{count}} days trial left. Click to upgrade."** CTA</td>',
			"</tr>",
			"</table>",
		].join("\n");
		const localMarkdown = [
			"| Item | Status | Action |",
			"| --- | --- | --- |",
			'| Trial days-left badge (`coach-trial-days-badge`) | Exists | Add inline **"i {{count}} days trial left. Click to upgrade."** CTA |',
		].join("\n");

		expect(notionMarkdownContentHash(localMarkdown)).toBe(
			notionMarkdownContentHash(remoteMarkdown),
		);
	});

	it("ignores rotating query signatures on Notion-hosted image URLs", () => {
		const firstFetch = [
			"# Screens",
			"",
			"![diagram](https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace/image.png?X-Amz-Signature=old)",
		].join("\n");
		const nextFetch = [
			"# Screens",
			"",
			"![diagram](https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace/image.png?X-Amz-Signature=new)",
		].join("\n");

		expect(notionMarkdownContentHash(firstFetch)).toBe(
			notionMarkdownContentHash(nextFetch),
		);
	});

	it("ignores rotating query signatures on Notion-hosted video URLs", () => {
		const firstFetch = [
			"# Demo",
			"",
			'<video controls src="https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace/demo.mp4?X-Amz-Signature=old"></video>',
		].join("\n");
		const nextFetch = [
			"# Demo",
			"",
			'<video controls src="https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace/demo.mp4?X-Amz-Signature=new"></video>',
		].join("\n");

		expect(notionMarkdownContentHash(firstFetch)).toBe(
			notionMarkdownContentHash(nextFetch),
		);
	});

	it("ignores rotating query signatures on Notion-hosted video source URLs", () => {
		const firstFetch = [
			"# Demo",
			"",
			"<video controls>",
			'<source src="https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace/demo.mp4?X-Amz-Signature=old" type="video/mp4">',
			"</video>",
		].join("\n");
		const nextFetch = [
			"# Demo",
			"",
			"<video controls>",
			'<source src="https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace/demo.mp4?X-Amz-Signature=new" type="video/mp4">',
			"</video>",
		].join("\n");

		expect(notionMarkdownContentHash(firstFetch)).toBe(
			notionMarkdownContentHash(nextFetch),
		);
	});
});

describe("notionMarkdownBodyForUpdate", () => {
	it("removes exported page properties and Hubble sync metadata before writeback", () => {
		const linked = buildNotionLinkedMarkdown(
			[
				"---",
				"Status: Draft",
				"PIC: []",
				"---",
				"",
				"# Roadmap",
				"",
				"![diagram](https://example.com/a.png)",
			].join("\n"),
			{
				result: notionPage,
				contentHash: "abc123",
			},
		);

		expect(notionMarkdownBodyForUpdate(linked)).toBe(
			"# Roadmap\n\n![diagram](https://example.com/a.png)",
		);
	});

	it("keeps body YAML blocks that are not leading page properties", () => {
		const linked = buildNotionLinkedMarkdown(
			[
				"---",
				"Status: Draft",
				"---",
				"",
				"Intro",
				"",
				"---",
				"example: body block",
				"---",
			].join("\n"),
			{
				result: notionPage,
				contentHash: "abc123",
			},
		);

		expect(notionMarkdownBodyForUpdate(linked)).toBe(
			"Intro\n\n---\nexample: body block\n\n---",
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
