import { describe, expect, it } from "vitest";
import { markdownToTiptapDoc } from "./markdownToProsemirror";
import {
	hasLinkedNotionFrontMatter,
	normalizeNotionMarkdownBody,
} from "./notionMarkdownNormalization";

describe("normalizeNotionMarkdownBody", () => {
	it("separates Notion dividers from preceding paragraphs", () => {
		expect(normalizeNotionMarkdownBody("Intro\n---\n## Next")).toBe(
			"Intro\n\n---\n## Next",
		);
	});

	it("keeps already separated dividers unchanged", () => {
		expect(normalizeNotionMarkdownBody("Intro\n\n---\n## Next")).toBe(
			"Intro\n\n---\n## Next",
		);
	});

	it("prevents Notion dividers from turning the previous paragraph into an H2", () => {
		const doc = markdownToTiptapDoc(
			normalizeNotionMarkdownBody("Intro\n---\n## Next"),
		);

		expect(doc.content?.map((node) => node.type)).toEqual([
			"paragraph",
			"horizontalRule",
			"heading",
		]);
		expect(doc.content?.[2]?.attrs).toMatchObject({ level: 2 });
	});

	it("leaves triple dash lines inside backtick fences unchanged", () => {
		const markdown = [
			"```yaml",
			"first: value",
			"---",
			"next: value",
			"```",
		].join("\n");

		expect(normalizeNotionMarkdownBody(markdown)).toBe(markdown);
	});

	it("leaves triple dash lines inside tilde fences unchanged", () => {
		const markdown = [
			"~~~yaml",
			"first: value",
			"---",
			"next: value",
			"~~~",
		].join("\n");

		expect(normalizeNotionMarkdownBody(markdown)).toBe(markdown);
	});

	it("does not close a fence on marker-looking code with trailing text", () => {
		const markdown = [
			"```",
			"```not a closing fence",
			"---",
			"```",
			"After",
		].join("\n");

		expect(normalizeNotionMarkdownBody(markdown)).toBe(markdown);
	});

	it("canonicalizes supported Notion HTML tables to saved GFM tables", () => {
		const notionTable = [
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

		expect(normalizeNotionMarkdownBody(notionTable)).toBe(
			[
				"| Item | Status | Action |",
				"| --- | --- | --- |",
				'| Trial days-left badge (`coach-trial-days-badge`) | Exists | Add inline **"i {{count}} days trial left. Click to upgrade."** CTA |',
			].join("\n"),
		);
	});

	it("separates GFM tables from adjacent prose for hash stability", () => {
		const markdown = [
			"Reference mapping from Plan Builder 14A.5.3:",
			"| goal_current | Primary | Secondary |",
			"| --- | --- | --- |",
			"| Build Muscle | 6-8 | 8-10 |",
			"Progression implication:",
		].join("\n");

		expect(normalizeNotionMarkdownBody(markdown)).toBe(
			[
				"Reference mapping from Plan Builder 14A.5.3:",
				"",
				"| goal_current | Primary | Secondary |",
				"| --- | --- | --- |",
				"| Build Muscle | 6-8 | 8-10 |",
				"",
				"Progression implication:",
			].join("\n"),
		);
	});

	it("does not canonicalize unsupported Notion HTML table spans", () => {
		const notionTable = [
			'<table header-row="true">',
			"<tr>",
			'<td colspan="2">Item</td>',
			"</tr>",
			"</table>",
		].join("\n");

		expect(normalizeNotionMarkdownBody(notionTable)).toBe(notionTable);
	});

	it("does not drop unsupported span rows from otherwise supported tables", () => {
		const notionTable = [
			'<table header-row="true">',
			"<tr>",
			"<td>Item</td>",
			"<td>Status</td>",
			"</tr>",
			"<tr>",
			"<td>Regular row</td>",
			"<td>Exists</td>",
			"</tr>",
			"<tr>",
			'<td colspan="2">Merged row</td>',
			"</tr>",
			"</table>",
		].join("\n");

		expect(normalizeNotionMarkdownBody(notionTable)).toBe(notionTable);
	});

	it("leaves Notion HTML tables inside code fences unchanged", () => {
		const markdown = [
			"```html",
			'<table header-row="true">',
			"<tr><td>Item</td></tr>",
			"</table>",
			"```",
		].join("\n");

		expect(normalizeNotionMarkdownBody(markdown)).toBe(markdown);
	});
});

describe("hasLinkedNotionFrontMatter", () => {
	it("detects Hubble linked Notion metadata", () => {
		expect(
			hasLinkedNotionFrontMatter(
				[
					"Status: Draft",
					"notion:",
					'  object: "page"',
					'  page_id: "page-id"',
					'  content_hash: "hash"',
					'  sync: "linked"',
				].join("\n"),
			),
		).toBe(true);
	});

	it("ignores unrelated notion frontmatter", () => {
		expect(
			hasLinkedNotionFrontMatter(
				["notion:", '  workspace: "personal"', '  sync: "manual"'].join("\n"),
			),
		).toBe(false);
	});

	it("requires a content hash before treating a file as linked", () => {
		expect(
			hasLinkedNotionFrontMatter(
				[
					"notion:",
					'  object: "page"',
					'  page_id: "page-id"',
					'  sync: "linked"',
				].join("\n"),
			),
		).toBe(false);
	});
});
