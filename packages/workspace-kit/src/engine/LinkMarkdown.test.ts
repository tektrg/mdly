import { describe, expect, it } from "vitest";
import { markdownToTiptapDoc } from "./markdownToProsemirror";
import { tiptapDocToMarkdown } from "./prosemirrorToMarkdown";

describe("link markdown conversion", () => {
	it("parses markdown links into link marks", () => {
		const doc = markdownToTiptapDoc("[OpenAI](https://openai.com)");
		const paragraph = doc.content?.[0];
		expect(paragraph?.type).toBe("paragraph");
		const textNode = paragraph?.content?.[0];
		expect(textNode?.type).toBe("text");
		expect(textNode?.text).toBe("OpenAI");
		expect(textNode?.marks).toEqual([
			{
				type: "link",
				attrs: { href: "https://openai.com", kind: "url", target: null },
			},
		]);
	});

	it("serializes link marks back to markdown links", () => {
		const markdown = tiptapDocToMarkdown({
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{
							type: "text",
							text: "OpenAI",
							marks: [{ type: "link", attrs: { href: "https://openai.com" } }],
						},
					],
				},
			],
		});
		expect(markdown).toBe("[OpenAI](https://openai.com)");
	});
});

describe("link where text equals href", () => {
	it("parses as regular link mark", () => {
		const doc = markdownToTiptapDoc(
			"[https://example.com](https://example.com)",
		);
		const paragraph = doc.content?.[0];
		const textNode = paragraph?.content?.[0];
		expect(textNode?.type).toBe("text");
		expect(textNode?.text).toBe("https://example.com");
		expect(textNode?.marks).toEqual([
			{
				type: "link",
				attrs: { href: "https://example.com", kind: "url", target: null },
			},
		]);
	});

	it("round-trips through markdown", () => {
		const input = "[https://example.com](https://example.com)";
		const doc = markdownToTiptapDoc(input);
		const output = tiptapDocToMarkdown(doc);
		expect(output).toBe(input);
	});
});

describe("wikilink markdown conversion", () => {
	it("parses wikilinks into wiki link marks", () => {
		const doc = markdownToTiptapDoc("[[Notes/File 2.md]]");
		const paragraph = doc.content?.[0];
		const textNode = paragraph?.content?.[0];
		expect(textNode?.type).toBe("text");
		expect(textNode?.text).toBe("File 2");
		expect(textNode?.marks).toEqual([
			{
				type: "link",
				attrs: {
					href: "Notes/File 2.md",
					kind: "wiki",
					target: "Notes/File 2.md",
				},
			},
		]);
	});

	it("round-trips wikilinks with custom titles", () => {
		const input = "[[Notes/File 2.md|My link]]";
		const doc = markdownToTiptapDoc(input);
		const output = tiptapDocToMarkdown(doc);
		expect(output).toBe(input);
	});

	it("serializes auto titles without an alias", () => {
		const markdown = tiptapDocToMarkdown({
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{
							type: "text",
							text: "File 2",
							marks: [
								{
									type: "link",
									attrs: {
										href: "/vault/Notes/File 2.md",
										kind: "wiki",
										target: "Notes/File 2.md",
									},
								},
							],
						},
					],
				},
			],
		});
		expect(markdown).toBe("[[Notes/File 2.md]]");
	});
});

describe("Notion mention page markdown conversion", () => {
	it("renders mention-page tags as compact Notion page links", () => {
		const url = "https://app.notion.com/p/f90eb74d673647d8b034ac9919ea3ff5";
		const doc = markdownToTiptapDoc(`See <mention-page url="${url}"/>`);
		const paragraph = doc.content?.[0];
		expect(paragraph?.type).toBe("paragraph");
		const mentionNode = paragraph?.content?.[1];
		expect(mentionNode?.type).toBe("text");
		expect(mentionNode?.text).toBe("Notion page f90eb74d");
		expect(mentionNode?.marks).toEqual([
			{
				type: "link",
				attrs: { href: url, kind: "notionMention", target: null },
			},
		]);
	});

	it("preserves mention-page syntax when serializing", () => {
		const input =
			'See <mention-page url="https://app.notion.com/p/f90eb74d673647d8b034ac9919ea3ff5"/>, then summarize';
		const doc = markdownToTiptapDoc(input);
		const output = tiptapDocToMarkdown(doc);
		expect(output).toBe(input);
	});
});
