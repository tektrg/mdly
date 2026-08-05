import { describe, expect, it } from "vitest";
import { markdownToTiptapDoc } from "./markdownToProsemirror";
import { tiptapDocToMarkdown } from "./prosemirrorToMarkdown";

describe("embed markdown conversion", () => {
	it("parses notion callout blocks and keeps following markdown parseable", () => {
		const doc = markdownToTiptapDoc(
			'<callout icon="/icons/checklist_blue.svg">\n**Focus**\n</callout>\n## Scope\n- **Item**',
		);

		expect(doc.content?.[0]).toMatchObject({
			type: "notionCallout",
			attrs: { icon: "/icons/checklist_blue.svg" },
			content: [
				{
					type: "paragraph",
					content: [
						{
							type: "text",
							text: "Focus",
							marks: [{ type: "bold" }],
						},
					],
				},
			],
		});
		expect(doc.content?.[1]).toEqual({
			type: "heading",
			attrs: { level: 2 },
			content: [{ type: "text", text: "Scope" }],
		});
		expect(doc.content?.[2]).toMatchObject({
			type: "bulletList",
			content: [
				{
					type: "listItem",
					content: [
						{
							type: "paragraph",
							content: [
								{
									type: "text",
									text: "Item",
									marks: [{ type: "bold" }],
								},
							],
						},
					],
				},
			],
		});
	});

	it("keeps paragraph markdown after notion callout blocks parseable", () => {
		const doc = markdownToTiptapDoc(
			"<callout>\nInside\n</callout>\nPlain **bold** after",
		);

		expect(doc.content?.[1]).toEqual({
			type: "paragraph",
			content: [
				{ type: "text", text: "Plain " },
				{ type: "text", text: "bold", marks: [{ type: "bold" }] },
				{ type: "text", text: " after" },
			],
		});
	});

	it("round-trips notion callout blocks", () => {
		const doc = markdownToTiptapDoc(
			'<callout icon="💡">\nUseful **context**\n</callout>',
		);

		expect(tiptapDocToMarkdown(doc)).toBe(
			'<callout icon="💡">\nUseful **context**\n</callout>',
		);
	});

	it("preserves extra notion callout attributes", () => {
		const input =
			'<callout icon="💡" color="yellow_background">\nUseful **context**\n</callout>';
		const doc = markdownToTiptapDoc(input);

		expect(doc.content?.[0]).toMatchObject({
			type: "notionCallout",
			attrs: {
				icon: "💡",
				rawAttributes: 'icon="💡" color="yellow_background"',
			},
		});
		expect(tiptapDocToMarkdown(doc)).toBe(input);
	});

	it("dedents notion callout contents before parsing markdown", () => {
		const doc = markdownToTiptapDoc(
			'<callout icon="/icons/checklist_blue.svg">\n\t**Focus**\n\tIndented detail\n</callout>',
		);

		expect(doc.content?.[0]).toMatchObject({
			type: "notionCallout",
			content: [
				{
					type: "paragraph",
					content: [
						{ type: "text", text: "Focus", marks: [{ type: "bold" }] },
						{ type: "text", text: "\nIndented detail" },
					],
				},
			],
		});
		expect(tiptapDocToMarkdown(doc)).toBe(
			'<callout icon="/icons/checklist_blue.svg">\n**Focus**\nIndented detail\n</callout>',
		);
	});

	it("parses and serializes notion empty blocks", () => {
		const doc = markdownToTiptapDoc("Before\n\n<empty-block/>\n\nAfter");

		expect(doc.content).toEqual([
			{ type: "paragraph", content: [{ type: "text", text: "Before" }] },
			{ type: "notionEmptyBlock" },
			{ type: "paragraph", content: [{ type: "text", text: "After" }] },
		]);
		expect(tiptapDocToMarkdown(doc)).toBe("Before\n\n<empty-block/>\n\nAfter");
	});

	it("preserves notion bookmark blocks as raw html blocks", () => {
		const input =
			'<bookmark url="https://example.com">\nExample caption\n</bookmark>';
		const doc = markdownToTiptapDoc(input);

		expect(doc.content).toEqual([
			{
				type: "notionHtmlBlock",
				attrs: { raw: input },
			},
		]);
		expect(tiptapDocToMarkdown(doc)).toBe(input);
	});

	it("preserves notion link preview blocks as raw html blocks", () => {
		const input = '<link-preview url="https://example.com"/>';
		const doc = markdownToTiptapDoc(input);

		expect(doc.content).toEqual([
			{
				type: "notionHtmlBlock",
				attrs: { raw: input },
			},
		]);
		expect(tiptapDocToMarkdown(doc)).toBe(input);
	});

	it("preserves notion video blocks as raw html blocks", () => {
		const input = '<video controls src="https://example.com/demo.mp4"></video>';
		const doc = markdownToTiptapDoc(input);

		expect(doc.content).toEqual([
			{
				type: "notionHtmlBlock",
				attrs: { raw: input },
			},
		]);
		expect(tiptapDocToMarkdown(doc)).toBe(input);
	});

	it("parses compact notion empty blocks", () => {
		const doc = markdownToTiptapDoc("Before\n<empty-block/>\nAfter");

		expect(doc.content).toEqual([
			{ type: "paragraph", content: [{ type: "text", text: "Before" }] },
			{ type: "notionEmptyBlock" },
			{ type: "paragraph", content: [{ type: "text", text: "After" }] },
		]);
	});

	it("parses consecutive notion empty blocks", () => {
		const doc = markdownToTiptapDoc(
			"Before\n<empty-block/>\n<empty-block/>\nAfter",
		);

		expect(doc.content).toEqual([
			{ type: "paragraph", content: [{ type: "text", text: "Before" }] },
			{ type: "notionEmptyBlock" },
			{ type: "notionEmptyBlock" },
			{ type: "paragraph", content: [{ type: "text", text: "After" }] },
		]);
	});

	it("parses a relative html iframe into an iframe embed node", () => {
		const doc = markdownToTiptapDoc(
			'# Demo\n\n<iframe src="./kanban.html"></iframe>',
		);

		expect(doc.content?.[1]).toEqual({
			type: "embed",
			attrs: {
				kind: "iframe",
				src: "./kanban.html",
			},
		});
	});

	it("does not parse remote iframe urls as embed nodes", () => {
		const doc = markdownToTiptapDoc(
			'<iframe src="https://google.com"></iframe>',
		);

		expect(doc.content?.[0]?.type).toBe("paragraph");
		expect(doc.content?.some((node) => node.type === "embed")).toBe(false);
	});

	it("does not parse unsafe iframe url schemes as embed nodes", () => {
		const doc = markdownToTiptapDoc(
			'<iframe src="javascript:alert(1)"></iframe>',
		);

		expect(doc.content?.[0]?.type).toBe("paragraph");
		expect(doc.content?.some((node) => node.type === "embed")).toBe(false);
	});

	it("serializes an iframe embed node back to iframe syntax", () => {
		const markdown = tiptapDocToMarkdown({
			type: "doc",
			content: [
				{
					type: "embed",
					attrs: {
						kind: "iframe",
						src: "./kanban.html",
					},
				},
			],
		});

		expect(markdown).toBe('<iframe src="./kanban.html"></iframe>');
	});
});
