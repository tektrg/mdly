import { describe, expect, it } from "vitest";
import { markdownToPlainText } from "./markdownToPlainText";

describe("markdownToPlainText", () => {
	it("returns empty string for empty input", () => {
		expect(markdownToPlainText("")).toBe("");
	});

	it("strips front matter from markdown", () => {
		const input = `---
title: Test Note
tags: [tag1, tag2]
---
# Main Header

This is content.`;
		expect(markdownToPlainText(input)).toBe("Main Header\nThis is content.");
	});

	it("strips bold, italic, code, and link markdown syntax", () => {
		const input =
			"Here is **bold text**, *italic text*, `inline code`, and a [link](https://example.com).";
		expect(markdownToPlainText(input)).toBe(
			"Here is bold text, italic text, inline code, and a link.",
		);
	});

	it("flattens headings and paragraphs with newline separators", () => {
		const input = "# Heading 1\n\nParagraph 1.\n\n## Heading 2\n\nParagraph 2.";
		expect(markdownToPlainText(input)).toBe(
			"Heading 1\nParagraph 1.\nHeading 2\nParagraph 2.",
		);
	});

	it("flattens lists and list items", () => {
		const input = "- Item 1\n- Item 2\n- Item 3";
		expect(markdownToPlainText(input)).toBe("Item 1\nItem 2\nItem 3");
	});

	it("flattens tables cleanly without markdown pipes and dashes", () => {
		const input = `| Column 1 | Column 2 |
|---|---|
| **Value 1** | \`Value 2\` |
| Value 3 | Value 4 |`;

		const plain = markdownToPlainText(input);
		expect(plain).toBe(
			"Column 1\nColumn 2\nValue 1\nValue 2\nValue 3\nValue 4",
		);
	});

	it("flattens blockquotes and nested content", () => {
		const input = "> **Note:** This is a quote.\n>\n> Second line.";
		expect(markdownToPlainText(input)).toBe(
			"Note: This is a quote.\nSecond line.",
		);
	});
});
