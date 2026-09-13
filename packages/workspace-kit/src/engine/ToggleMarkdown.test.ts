import { describe, expect, it } from "vitest";
import { markdownToTiptapDoc } from "./markdownToProsemirror";
import { tiptapDocToMarkdown } from "./prosemirrorToMarkdown";

describe("toggle block markdown conversion", () => {
	it("parses a details/summary block into a toggle node", () => {
		const doc = markdownToTiptapDoc(
			"<details>\n<summary>Title</summary>\nBody text\n</details>",
		);

		expect(doc.content?.[0]).toEqual({
			type: "toggle",
			attrs: { open: false },
			content: [
				{
					type: "toggleSummary",
					content: [{ type: "text", text: "Title" }],
				},
				{
					type: "paragraph",
					content: [{ type: "text", text: "Body text" }],
				},
			],
		});
	});

	it("round-trips a details/summary block", () => {
		const input = "<details>\n<summary>Title</summary>\nBody text\n</details>";
		const doc = markdownToTiptapDoc(input);

		expect(tiptapDocToMarkdown(doc)).toBe(input);
	});

	it("parses rich text (bold) in the summary title", () => {
		const doc = markdownToTiptapDoc(
			"<details>\n<summary>**Bold title**</summary>\nBody\n</details>",
		);

		expect(doc.content?.[0]?.content?.[0]).toEqual({
			type: "toggleSummary",
			content: [
				{ type: "text", text: "Bold title", marks: [{ type: "bold" }] },
			],
		});
	});

	it("supports nested block content (heading + list) in the toggle body", () => {
		const input =
			"<details>\n<summary>Notes</summary>\n## Heading\n- Item one\n- Item two\n</details>";
		const doc = markdownToTiptapDoc(input);

		expect(doc.content?.[0]).toMatchObject({
			type: "toggle",
			content: [
				{ type: "toggleSummary", content: [{ type: "text", text: "Notes" }] },
				{
					type: "heading",
					attrs: { level: 2 },
					content: [{ type: "text", text: "Heading" }],
				},
				{
					type: "bulletList",
					content: [
						{
							type: "listItem",
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "Item one" }],
								},
							],
						},
						{
							type: "listItem",
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "Item two" }],
								},
							],
						},
					],
				},
			],
		});
		expect(tiptapDocToMarkdown(doc)).toBe(input);
	});

	it("reads an existing `open` attribute as the initial state but never re-emits it", () => {
		const doc = markdownToTiptapDoc(
			"<details open>\n<summary>Title</summary>\nBody\n</details>",
		);

		expect(doc.content?.[0]).toMatchObject({
			type: "toggle",
			attrs: { open: true },
		});
		// Collapse/expand state is ephemeral UI state, never persisted to markdown.
		expect(tiptapDocToMarkdown(doc)).toBe(
			"<details>\n<summary>Title</summary>\nBody\n</details>",
		);
	});

	it("keeps following markdown parseable after a toggle block", () => {
		const doc = markdownToTiptapDoc(
			"<details>\n<summary>Title</summary>\nBody\n</details>\n\n## After",
		);

		expect(doc.content?.[1]).toEqual({
			type: "heading",
			attrs: { level: 2 },
			content: [{ type: "text", text: "After" }],
		});
	});

	it("falls back to raw text for a details block without a summary", () => {
		const doc = markdownToTiptapDoc(
			"<details>\nJust body, no summary\n</details>",
		);

		expect(doc.content?.[0]?.type).toBe("paragraph");
		expect(doc.content?.some((node) => node.type === "toggle")).toBe(false);
	});

	it("round-trips a full document with multiple toggles and surrounding content", () => {
		const input = [
			"# Toggle block test",
			"",
			"<details>",
			"<summary>**Bold title** with plain text</summary>",
			"Body paragraph.",
			"## Nested heading",
			"- Nested item one",
			"- Nested item two",
			"</details>",
			"",
			"Paragraph after the toggle.",
			"",
			"<details>",
			"<summary>New toggle title</summary>",
			"</details>",
		].join("\n");

		const doc = markdownToTiptapDoc(input);
		expect(tiptapDocToMarkdown(doc)).toBe(input);
	});

	it("serializes an empty toggle body as a single empty paragraph", () => {
		const markdown = tiptapDocToMarkdown({
			type: "doc",
			content: [
				{
					type: "toggle",
					attrs: { open: false },
					content: [
						{
							type: "toggleSummary",
							content: [{ type: "text", text: "Title" }],
						},
						{ type: "paragraph" },
					],
				},
			],
		});

		expect(markdown).toBe("<details>\n<summary>Title</summary>\n</details>");
		expect(markdownToTiptapDoc(markdown).content?.[0]).toMatchObject({
			type: "toggle",
			content: [{ type: "toggleSummary" }, { type: "paragraph", content: [] }],
		});
	});

	it("parses a toggle whose body is a table (remark splits the html span)", () => {
		const input =
			"<details>\n<summary>Title</summary>\n| a | b |\n|---|---|\n| 1 | 2 |\n</details>";
		const doc = markdownToTiptapDoc(input);

		expect(doc.content?.[0]).toMatchObject({ type: "toggle" });
		expect(
			doc.content?.[0]?.content?.some((node) => node.type === "table"),
		).toBe(true);
		// The table serializer pads delimiter cells (standard behaviour —
		// see TableMarkdown.test.ts); the toggle span itself round-trips.
		expect(tiptapDocToMarkdown(doc)).toBe(
			"<details>\n<summary>Title</summary>\n| a | b |\n| --- | --- |\n| 1 | 2 |\n</details>",
		);
		// And the normalized form is stable on reload.
		expect(
			markdownToTiptapDoc(tiptapDocToMarkdown(doc)).content?.[0],
		).toMatchObject({ type: "toggle" });
	});

	it("parses a toggle whose body has blank lines and mixed blocks", () => {
		const input = [
			"<details>",
			"<summary>Title</summary>",
			"",
			"Para one.",
			"",
			"| a | b |",
			"|---|---|",
			"| 1 | 2 |",
			"",
			"</details>",
			"",
			"## After",
		].join("\n");
		const doc = markdownToTiptapDoc(input);

		expect(doc.content?.[0]).toMatchObject({ type: "toggle" });
		const types = doc.content?.[0]?.content?.map((node) => node.type);
		expect(types).toContain("paragraph");
		expect(types).toContain("table");
		expect(doc.content?.[1]).toMatchObject({ type: "heading" });
	});

	it("leaves an unclosed details block on the old raw-text fallback", () => {
		const doc = markdownToTiptapDoc(
			"<details>\n<summary>Title</summary>\nBody",
		);

		expect(doc.content?.some((node) => node.type === "toggle")).toBe(false);
	});

	it("dedents tab-indented prose around column-0 html tags (garden #1870)", () => {
		// Agent-authored shape: Notion-style tab-indented prose with a pasted
		// `<table>` at column 0. The html tags must not veto the dedent, or
		// the tabs become indented code blocks.
		const input = [
			"<details>",
			"<summary>Title</summary>",
			"\t# Heading",
			"\tProse with **bold**.",
			"\t> A quote.",
			"<table>",
			"<tr>",
			"<td>Cell</td>",
			"</tr>",
			"</table>",
			'\t## <span discussion-urls="discussion://abc">Sub</span>',
			"</details>",
		].join("\n");
		const doc = markdownToTiptapDoc(input);

		expect(doc.content?.[0]).toMatchObject({ type: "toggle" });
		const types = doc.content?.[0]?.content?.map((node) => node.type);
		expect(types).toContain("heading");
		expect(types).toContain("paragraph");
		expect(types).toContain("blockquote");
		expect(types).not.toContain("codeBlock");
	});
});
