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
				raw: '<iframe src="./kanban.html"></iframe>',
				width: null,
				height: null,
			},
		});
	});

	it("parses remote https iframe urls as embed nodes", () => {
		const doc = markdownToTiptapDoc(
			'<iframe src="https://google.com"></iframe>',
		);

		expect(doc.content?.[0]).toMatchObject({
			type: "embed",
			attrs: { kind: "iframe", src: "https://google.com" },
		});
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

	const SHEETCANVAS =
		'<iframe src="https://sheetcanvas.com/e/p/twj52zqhzb" title="SheetCanvas page" width="100%" height="800" style="border:0;max-width:100%" loading="lazy"></iframe>';
	const TWEET =
		'<iframe src="https://platform.twitter.com/embed/Tweet.html?id=20" width="550" height="600"></iframe>';
	const YOUTUBE =
		'<iframe width=\'560\' height=315 src=\'https://www.youtube.com/embed/dQw4w9WgXcQ\' title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>';

	it.each([
		["sheetcanvas", SHEETCANVAS],
		["x / twitter", TWEET],
		["youtube (allow + allowfullscreen, mixed quoting)", YOUTUBE],
	])("round-trips a remote %s iframe byte-identical", (_name, html) => {
		const input = `# Doc\n\n${html}\n\nAfter`;
		const doc = markdownToTiptapDoc(input);
		expect(doc.content?.[1]?.type).toBe("embed");
		expect(tiptapDocToMarkdown(doc)).toBe(input);
	});

	it("keeps the sheetcanvas size attributes on the node", () => {
		const doc = markdownToTiptapDoc(SHEETCANVAS);
		expect(doc.content?.[0]?.attrs).toMatchObject({
			src: "https://sheetcanvas.com/e/p/twj52zqhzb",
			width: "100%",
			height: "800",
			raw: SHEETCANVAS,
		});
	});

	it("rewrites only height (in place) after a resize", () => {
		const doc = markdownToTiptapDoc(SHEETCANVAS);
		const embed = doc.content?.[0];
		if (!embed?.attrs) throw new Error("no embed");
		embed.attrs.height = "420";
		expect(tiptapDocToMarkdown(doc)).toBe(
			SHEETCANVAS.replace('height="800"', 'height="420"'),
		);
	});

	it("rewrites unquoted / single-quoted sizes and appends a missing height", () => {
		const doc = markdownToTiptapDoc(YOUTUBE);
		const embed = doc.content?.[0];
		if (!embed?.attrs) throw new Error("no embed");
		embed.attrs.height = "500";
		embed.attrs.width = "640";
		expect(tiptapDocToMarkdown(doc)).toBe(
			YOUTUBE.replace("width='560'", "width='640'").replace(
				"height=315",
				'height="500"',
			),
		);

		const bare = markdownToTiptapDoc(
			'<iframe src="https://example.com/x" data-height="1"></iframe>',
		);
		const node = bare.content?.[0];
		if (!node?.attrs) throw new Error("no embed");
		node.attrs.height = "300";
		expect(tiptapDocToMarkdown(bare)).toBe(
			'<iframe src="https://example.com/x" data-height="1" height="300"></iframe>',
		);
	});

	it("round-trips a remote iframe inside a columns block", () => {
		const input = `::: columns\n${TWEET}\n+++\nSide text\n:::`;
		const doc = markdownToTiptapDoc(input);
		const group = doc.content?.[0];
		expect(group?.type).toBe("columns");
		expect(group?.content?.[0]?.content?.[0]).toMatchObject({
			type: "embed",
			attrs: { src: "https://platform.twitter.com/embed/Tweet.html?id=20" },
		});
		expect(tiptapDocToMarkdown(doc)).toBe(input);
	});

	it.each([
		'<iframe src="http://example.com/page"></iframe>',
		'<iframe src="javascript:alert(1)"></iframe>',
		'<iframe src="data:text/html,hi"></iframe>',
		'<iframe src="file:///etc/hosts"></iframe>',
		'<iframe src="//example.com/x"></iframe>',
	])("keeps %s as raw text (no embed), losslessly", (input) => {
		const doc = markdownToTiptapDoc(input);
		expect(doc.content?.some((node) => node.type === "embed")).toBe(false);
		expect(tiptapDocToMarkdown(doc)).toBe(input);
	});

	it("leaves an iframe inline in a paragraph as text, losslessly", () => {
		const input = `See ${TWEET} inline.`;
		const doc = markdownToTiptapDoc(input);
		expect(doc.content?.[0]?.type).toBe("paragraph");
		expect(doc.content?.some((node) => node.type === "embed")).toBe(false);
		expect(tiptapDocToMarkdown(doc)).toBe(input);
	});
});
