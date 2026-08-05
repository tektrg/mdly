import { describe, expect, it } from "vitest";
import { markdownToTiptapDoc } from "./markdownToProsemirror";
import { tiptapDocToMarkdown } from "./prosemirrorToMarkdown";

describe("table markdown conversion", () => {
	const notionHtmlTable = `<table header-row="true">
<tr>
<td>Item</td>
<td>Status</td>
<td>Action</td>
</tr>

<tr>
<td>Guest 3-free-coach + banner (\`coach-guest-trial-banner\`)</td>
<td>Exists</td>
<td>Confirm disclaimer copy = "30-day free trial / sign up"; verify it shows on every entry, not just home</td>
</tr>

<tr>
<td>Trial days-left badge (\`coach-trial-days-badge\`)</td>
<td>Exists</td>
<td>Add inline **"i {{count}} days trial left. Click to upgrade."** CTA under chips -> opens wall (NEW)</td>
</tr>
</table>`;

	it("parses GFM tables into table nodes", () => {
		const doc = markdownToTiptapDoc(
			"| Column A | Column B |\n| --- | --- |\n| Cell 1 | Cell 2 |",
		);

		expect(doc.content?.[0]).toEqual({
			type: "table",
			content: [
				{
					type: "tableRow",
					content: [
						{
							type: "tableHeader",
							attrs: { align: null },
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "Column A" }],
								},
							],
						},
						{
							type: "tableHeader",
							attrs: { align: null },
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "Column B" }],
								},
							],
						},
					],
				},
				{
					type: "tableRow",
					content: [
						{
							type: "tableCell",
							attrs: { align: null },
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "Cell 1" }],
								},
							],
						},
						{
							type: "tableCell",
							attrs: { align: null },
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "Cell 2" }],
								},
							],
						},
					],
				},
			],
		});
	});

	it("round-trips table text and alignment", () => {
		const input =
			"| Left | Center | Right |\n| :--- | :---: | ---: |\n| **A** | B | C |";
		const doc = markdownToTiptapDoc(input);

		expect(tiptapDocToMarkdown(doc)).toBe(input);
	});

	it("parses pipe tables adjacent to prose as table blocks", () => {
		const input = [
			"Reference mapping from Plan Builder 14A.5.3:",
			"| goal_current | Primary | Secondary |",
			"| --- | --- | --- |",
			"| Build Muscle | 6-8 | 8-10 |",
			"Progression implication:",
		].join("\n");
		const doc = markdownToTiptapDoc(input);

		expect(doc.content?.map((node) => node.type)).toEqual([
			"paragraph",
			"table",
			"paragraph",
		]);
		expect(tiptapDocToMarkdown(doc)).toBe(
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

	it("escapes pipes when serializing cell content", () => {
		const markdown = tiptapDocToMarkdown({
			type: "doc",
			content: [
				{
					type: "table",
					content: [
						{
							type: "tableRow",
							content: [
								{
									type: "tableHeader",
									attrs: { align: null },
									content: [
										{
											type: "paragraph",
											content: [{ type: "text", text: "A | B" }],
										},
									],
								},
							],
						},
						{
							type: "tableRow",
							content: [
								{
									type: "tableCell",
									attrs: { align: null },
									content: [
										{
											type: "paragraph",
											content: [{ type: "text", text: "Cell | value" }],
										},
									],
								},
							],
						},
					],
				},
			],
		});

		expect(markdown).toBe("| A \\| B |\n| --- |\n| Cell \\| value |");
	});

	it("keeps escaped pipes inside inline code literal when serializing cell content", () => {
		const input = "| Example |\n| --- |\n| `a\\|b` |";
		const doc = markdownToTiptapDoc(input);

		expect(tiptapDocToMarkdown(doc)).toBe(input);
	});

	it("round-trips <br> line breaks inside table cells", () => {
		const input = "| Example |\n| --- |\n| line1<br>line2 |";
		const doc = markdownToTiptapDoc(input);

		const cellParagraph =
			doc.content?.[0]?.content?.[1]?.content?.[0]?.content?.[0];
		expect(cellParagraph?.content?.map((node) => node.type)).toEqual([
			"text",
			"hardBreak",
			"text",
		]);
		expect(tiptapDocToMarkdown(doc)).toBe(input);
	});

	it("round-trips self-closing <br/> line breaks inside table cells", () => {
		const input = "| Example |\n| --- |\n| line1<br/>line2 |";
		const doc = markdownToTiptapDoc(input);

		expect(tiptapDocToMarkdown(doc)).toBe("| Example |\n| --- |\n| line1<br>line2 |");
	});

	it("parses Notion HTML tables with header-row into table nodes", () => {
		const doc = markdownToTiptapDoc(notionHtmlTable);
		const table = doc.content?.[0];

		expect(table?.type).toBe("table");
		expect(table?.content?.[0]?.content?.map((cell) => cell.type)).toEqual([
			"tableHeader",
			"tableHeader",
			"tableHeader",
		]);
		expect(table?.content?.slice(1).map((row) => row.content?.length)).toEqual([
			3, 3,
		]);
		expect(table?.content?.[1]?.content?.map((cell) => cell.type)).toEqual([
			"tableCell",
			"tableCell",
			"tableCell",
		]);
	});

	it("parses Notion HTML tables with a colgroup into table nodes", () => {
		const notionHtmlTableWithColgroup = `<table fit-page-width="true" header-row="true" header-column="true">
<colgroup>
<col width="265">
<col width="46">
</colgroup>
<tr>
<td>Item</td>
<td>Status</td>
</tr>
<tr>
<td>Row 1</td>
<td>Exists</td>
</tr>
</table>`;

		const doc = markdownToTiptapDoc(notionHtmlTableWithColgroup);
		const table = doc.content?.[0];

		expect(table?.type).toBe("table");
		expect(table?.content?.[0]?.content?.map((cell) => cell.type)).toEqual([
			"tableHeader",
			"tableHeader",
		]);
		expect(tiptapDocToMarkdown(doc)).toBe(
			["| Item | Status |", "| --- | --- |", "| Row 1 | Exists |"].join("\n"),
		);
	});

	it("serializes supported Notion HTML tables to stable GFM markdown", () => {
		const doc = markdownToTiptapDoc(notionHtmlTable);

		expect(tiptapDocToMarkdown(doc)).toBe(
			[
				"| Item | Status | Action |",
				"| --- | --- | --- |",
				'| Guest 3-free-coach + banner (`coach-guest-trial-banner`) | Exists | Confirm disclaimer copy = "30-day free trial / sign up"; verify it shows on every entry, not just home |',
				'| Trial days-left badge (`coach-trial-days-badge`) | Exists | Add inline **"i {{count}} days trial left. Click to upgrade."** CTA under chips -> opens wall (NEW) |',
			].join("\n"),
		);
	});
});
