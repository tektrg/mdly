import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { markdownToTiptapDoc } from "./markdownToProsemirror";
import { tiptapDocToMarkdown } from "./prosemirrorToMarkdown";

function firstTextNode(doc: JSONContent): JSONContent | undefined {
	return doc.content?.find((n) => n.type === "paragraph")?.content?.[0];
}

describe("bold markdown asterisk normalization", () => {
	it("parses a single bold span into exactly one bold mark", () => {
		const text = firstTextNode(markdownToTiptapDoc("**isCompound()**"));
		expect(text?.text).toBe("isCompound()");
		expect(text?.marks).toEqual([{ type: "bold" }]);
	});

	it("does not stack duplicate bold marks for nested asterisks", () => {
		// Externally-authored markdown (e.g. an agent) can arrive over-wrapped.
		const text = firstTextNode(markdownToTiptapDoc("******isCompound()******"));
		expect(text?.marks).toEqual([{ type: "bold" }]);
	});

	it("heals over-wrapped bold back to a single asterisk pair on round-trip", () => {
		expect(tiptapDocToMarkdown(markdownToTiptapDoc("****isCompound()****"))).toBe(
			"**isCompound()**",
		);
		expect(
			tiptapDocToMarkdown(markdownToTiptapDoc("******isCompound()******")),
		).toBe("**isCompound()**");
	});

	it("serializes duplicate bold marks as a single pair (idempotent)", () => {
		const markdown = tiptapDocToMarkdown({
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{
							type: "text",
							text: "isCompound()",
							marks: [{ type: "bold" }, { type: "bold" }, { type: "bold" }],
						},
					],
				},
			],
		});
		expect(markdown).toBe("**isCompound()**");
	});

	it("keeps clean bold stable across repeated round-trips", () => {
		let markdown = "**grow**";
		for (let i = 0; i < 4; i += 1) {
			markdown = tiptapDocToMarkdown(markdownToTiptapDoc(markdown));
		}
		expect(markdown).toBe("**grow**");
	});

	it("preserves bold+italic combination", () => {
		expect(tiptapDocToMarkdown(markdownToTiptapDoc("***both***"))).toBe(
			"***both***",
		);
	});
});
