import { describe, expect, it } from "vitest";
import { markdownToTiptapDoc } from "./markdownToProsemirror";
import { tiptapDocToMarkdown } from "./prosemirrorToMarkdown";

describe("image markdown conversion", () => {
	it("parses markdown image into image node", () => {
		const doc = markdownToTiptapDoc("![diagram](example.assets/abc123.png)");
		const image = doc.content?.[0];
		expect(image?.type).toBe("image");
		expect(image?.attrs).toEqual({
			src: "example.assets/abc123.png",
			alt: "diagram",
			title: undefined,
		});
	});

	it("serializes image node back to markdown image syntax", () => {
		const markdown = tiptapDocToMarkdown({
			type: "doc",
			content: [
				{
					type: "image",
					attrs: {
						src: "example.assets/abc123.png",
						alt: "diagram",
					},
				},
			],
		});
		expect(markdown).toBe("![diagram](example.assets/abc123.png)");
	});

	it("keeps inline markdown images loadable by splitting them into image blocks", () => {
		const doc = markdownToTiptapDoc(
			"Before ![diagram](https://example.com/a.png) after",
		);

		expect(doc.content).toEqual([
			{ type: "paragraph", content: [{ type: "text", text: "Before" }] },
			{
				type: "image",
				attrs: {
					src: "https://example.com/a.png",
					alt: "diagram",
					title: undefined,
				},
			},
			{ type: "paragraph", content: [{ type: "text", text: "after" }] },
		]);
		expect(tiptapDocToMarkdown(doc)).toBe(
			"Before\n\n![diagram](https://example.com/a.png)\n\nafter",
		);
	});

	it("ignores markdown images with empty URLs", () => {
		const doc = markdownToTiptapDoc("before\n\n![]()\n\nafter");
		expect(doc.content?.some((node) => node.type === "image")).toBe(false);
	});
});
