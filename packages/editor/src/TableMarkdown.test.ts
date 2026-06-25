import { describe, expect, it } from "vitest";
import { markdownToTiptapDoc } from "./markdownToProsemirror";
import { tiptapDocToMarkdown } from "./prosemirrorToMarkdown";

describe("table markdown conversion", () => {
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
});
