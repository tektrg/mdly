import { describe, expect, it } from "vitest";
import {
	buildDocSourceMarkdown,
	buildDocSourceMarkdownFromMetadata,
	parseDocSourceMetadata,
	stripDocSourceMetadata,
} from "./docSourceMarkdown";

const docSource = {
	kind: "docx",
	origin: "file" as const,
	path: "/Users/test/Documents/report.docx",
	title: "Report / Q3",
	importedAt: "2026-08-11T10:00:00.000Z",
	contentHash: "abc123",
	converter: "anydoc@1.0.0",
};

describe("buildDocSourceMarkdown", () => {
	it("merges source metadata into existing frontmatter", () => {
		const markdown = "---\nStatus: Draft\n---\n# Report\n";

		expect(buildDocSourceMarkdown(markdown, docSource)).toBe(
			[
				"---",
				"Status: Draft",
				"source:",
				'  object: "document"',
				'  kind: "docx"',
				'  origin: "file"',
				'  url: ""',
				'  path: "/Users/test/Documents/report.docx"',
				'  title: "Report / Q3"',
				'  imported_at: "2026-08-11T10:00:00.000Z"',
				'  content_hash: "abc123"',
				'  converter: "anydoc@1.0.0"',
				'  sync: "imported"',
				"---",
				"# Report\n",
			].join("\n"),
		);
	});

	it("creates frontmatter when the markdown body has none", () => {
		const result = buildDocSourceMarkdown("# Report\n", docSource);

		expect(result).toContain('kind: "docx"');
		expect(result).toContain("# Report");
	});

	it("replaces existing source metadata instead of duplicating it", () => {
		const first = buildDocSourceMarkdown("# Report\n", docSource);
		const second = buildDocSourceMarkdownFromMetadata(first, {
			object: "document",
			kind: "docx",
			origin: "file",
			url: null,
			path: "/Users/test/Documents/report.docx",
			title: "Report / Q3",
			importedAt: "2026-08-11T10:00:00.000Z",
			contentHash: "new-hash",
			converter: "anydoc@1.0.0",
			sync: "imported",
		});

		expect(second.match(/^source:/gm)).toHaveLength(1);
		expect(second).toContain('content_hash: "new-hash"');
		expect(second).not.toContain("abc123");
	});
});

describe("parseDocSourceMetadata", () => {
	it("reads source frontmatter metadata", () => {
		const result = buildDocSourceMarkdown("# Report\n", docSource);

		expect(parseDocSourceMetadata(result)).toEqual({
			object: "document",
			kind: "docx",
			origin: "file",
			url: null,
			path: "/Users/test/Documents/report.docx",
			title: "Report / Q3",
			importedAt: "2026-08-11T10:00:00.000Z",
			contentHash: "abc123",
			converter: "anydoc@1.0.0",
			sync: "imported",
		});
	});

	it("returns null for markdown without source metadata", () => {
		expect(parseDocSourceMetadata("# Plain markdown")).toBeNull();
	});

	it("returns null for Notion-linked markdown (not source)", () => {
		const notionMarkdown = [
			"---",
			"notion:",
			'  object: "page"',
			'  page_id: "abc"',
			'  sync: "linked"',
			"---",
			"# Notion page",
		].join("\n");

		expect(parseDocSourceMetadata(notionMarkdown)).toBeNull();
	});
});

describe("stripDocSourceMetadata", () => {
	it("removes source metadata before user editing", () => {
		const result = buildDocSourceMarkdown(
			"---\nStatus: Draft\n---\n# Report\n",
			docSource,
		);

		expect(stripDocSourceMetadata(result)).toBe(
			"---\nStatus: Draft\n---\n# Report\n",
		);
	});

	it("keeps non-source frontmatter intact", () => {
		const markdown = [
			"---",
			"Status: Draft",
			"source:",
			'  object: "document"',
			'  kind: "docx"',
			'  sync: "imported"',
			"---",
			"# Report",
		].join("\n");

		expect(stripDocSourceMetadata(markdown)).toBe(
			"---\nStatus: Draft\n---\n# Report",
		);
	});
});