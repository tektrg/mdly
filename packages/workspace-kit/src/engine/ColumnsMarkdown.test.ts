import { describe, expect, it } from "vitest";
import { markdownToTiptapDoc } from "./markdownToProsemirror";
import { tiptapDocToMarkdown } from "./prosemirrorToMarkdown";

const roundTrip = (markdown: string) =>
	tiptapDocToMarkdown(markdownToTiptapDoc(markdown));

describe("image size suffix", () => {
	it("parses |W into width and keeps alt clean", () => {
		const doc = markdownToTiptapDoc("![Before|300](a.png)");
		expect(doc.content?.[0]?.attrs).toMatchObject({
			src: "a.png",
			alt: "Before",
			width: 300,
		});
		expect(doc.content?.[0]?.attrs?.height).toBeUndefined();
	});

	it("parses |WxH into width and height", () => {
		const doc = markdownToTiptapDoc("![x|400x300](a.png)");
		expect(doc.content?.[0]?.attrs).toMatchObject({
			alt: "x",
			width: 400,
			height: 300,
		});
	});

	it.each([
		"![alt](a.png)",
		"![](a.png)",
		"![Before|300](a.png)",
		"![|300](a.png)",
		"![a|400x300](dir/a%20b.png)",
		"![a|b](a.png)",
	])("round-trips %s byte-identical", (markdown) => {
		expect(roundTrip(markdown)).toBe(markdown);
	});

	it("serializes resized width", () => {
		expect(
			tiptapDocToMarkdown({
				type: "doc",
				content: [
					{ type: "image", attrs: { src: "a.png", alt: "a", width: 250.4 } },
				],
			}),
		).toBe("![a|250](a.png)");
	});
});

describe("columns block", () => {
	it("parses the spec example into columns with mixed content", () => {
		const doc = markdownToTiptapDoc(
			"::: columns\n![Before|300](a.png)\n+++\n![After|300](b.png)\nSome caption **text**.\n:::",
		);
		const columns = doc.content?.[0];
		expect(columns?.type).toBe("columns");
		expect(columns?.attrs).toEqual({ ratio: null });
		expect(columns?.content?.map((c) => c.type)).toEqual(["column", "column"]);
		expect(columns?.content?.[0]?.content?.[0]).toMatchObject({
			type: "image",
			attrs: { src: "a.png", alt: "Before", width: 300 },
		});
		expect(columns?.content?.[1]?.content?.map((n) => n.type)).toEqual([
			"image",
			"paragraph",
		]);
	});

	it("is stable after one normalizing pass", () => {
		const once = roundTrip(
			"::: columns\n![Before|300](a.png)\n+++\n![After|300](b.png)\nSome caption **text**.\n:::",
		);
		expect(once).toBe(
			"::: columns\n![Before|300](a.png)\n+++\n![After|300](b.png)\n\nSome caption **text**.\n:::",
		);
		expect(roundTrip(once)).toBe(once);
	});

	it("keeps the ratio and three columns", () => {
		const input =
			"intro\n\n::: columns 2:1:1\n- a\n- b\n+++\n# Title\n+++\ntext\n:::\n\noutro";
		const doc = markdownToTiptapDoc(input);
		expect(doc.content?.[1]?.attrs).toEqual({ ratio: "2:1:1" });
		expect(doc.content?.[1]?.content).toHaveLength(3);
		expect(doc.content?.map((n) => n.type)).toEqual([
			"paragraph",
			"columns",
			"paragraph",
		]);
		expect(roundTrip(input)).toBe(input);
	});

	it("keeps an unclosed group as plain text without losing content", () => {
		const input = "::: columns\nleft\n+++\nright";
		const text = JSON.stringify(markdownToTiptapDoc(input));
		expect(text).not.toContain('"columns"');
		for (const part of ["::: columns", "left", "+++", "right"]) {
			expect(text).toContain(part);
		}
	});

	it("does not nest columns: inner opener stays literal text", () => {
		const doc = markdownToTiptapDoc(
			"::: columns\n::: columns\na\n+++\nb\n:::\n\nafter\n\n:::",
		);
		expect(doc.content?.[0]?.type).toBe("columns");
		const json = JSON.stringify(doc);
		expect(json.match(/"type":"columns"/g)).toHaveLength(1);
		expect(json).toContain("after");
	});

	it("ignores ::: and +++ inside fenced code", () => {
		const input = "::: columns\n```\n+++\n:::\n```\n+++\nb\n:::";
		const doc = markdownToTiptapDoc(input);
		expect(doc.content?.[0]?.content).toHaveLength(2);
		expect(doc.content?.[0]?.content?.[0]?.content?.[0]).toMatchObject({
			type: "codeBlock",
			content: [{ type: "text", text: "+++\n:::" }],
		});
		expect(roundTrip(input)).toBe(input);
	});

	it("gives an empty column an empty paragraph", () => {
		const doc = markdownToTiptapDoc("::: columns\na\n+++\n:::");
		expect(doc.content?.[0]?.content?.[1]?.content).toMatchObject([
			{ type: "paragraph" },
		]);
	});

	it("rejects an invalid ratio (stays text)", () => {
		const doc = markdownToTiptapDoc("::: columns wide\na\n:::");
		expect(JSON.stringify(doc)).not.toContain('"columns"');
	});
	it("keeps a literal +++ or ::: paragraph inside its column across saves", () => {
		const doc = {
			type: "doc",
			content: [
				{
					type: "columns",
					attrs: { ratio: null },
					content: ["+++", ":::", "::: columns"].map((text) => ({
						type: "column",
						content: [
							{ type: "paragraph", content: [{ type: "text", text: "x" }] },
							{ type: "paragraph", content: [{ type: "text", text }] },
						],
					})),
				},
			],
		};
		const saved = tiptapDocToMarkdown(doc);
		const reparsed = markdownToTiptapDoc(saved);
		expect(reparsed.content).toHaveLength(1);
		expect(reparsed.content?.[0]?.content).toHaveLength(3);
		expect(tiptapDocToMarkdown(reparsed)).toBe(saved);
		expect(JSON.stringify(reparsed)).toContain('"text":"+++"');
		expect(JSON.stringify(reparsed)).toContain('"text":":::"');
	});
});
