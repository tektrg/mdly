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

describe("formatting that spans an inline code span", () => {
	// TipTap splits the sentence into three text nodes at the code span.
	// Wrapping each one on its own emitted `**a ****`b`**** c**`, which
	// CommonMark renders as literal asterisks instead of bold.
	const roundTrip = (markdown: string) =>
		tiptapDocToMarkdown(markdownToTiptapDoc(markdown));

	it("emits one bold pair around bold text containing inline code", () => {
		expect(roundTrip("**Rule: run `realpath` on the file**")).toBe(
			"**Rule: run `realpath` on the file**",
		);
	});

	it("keeps a code span's own asterisks literal inside bold", () => {
		expect(roundTrip("**any `**/.claude/skills/**/*` change**")).toBe(
			"**any `**/.claude/skills/**/*` change**",
		);
	});

	it("handles several code spans in one bold sentence", () => {
		const markdown =
			"**before committing any `a` change, run `b` — don't assume `c`.**";
		expect(roundTrip(markdown)).toBe(markdown);
	});

	it("does the same for italic and strikethrough", () => {
		expect(roundTrip("*run `realpath` first*")).toBe("*run `realpath` first*");
		expect(roundTrip("~~run `realpath` first~~")).toBe(
			"~~run `realpath` first~~",
		);
	});

	it("survives a bullet item, where the damage was first seen", () => {
		const markdown = "- **Workspace root `CLAUDE.md` is a symlink** → this file";
		expect(roundTrip(markdown)).toBe(markdown);
	});

	it("emits one bold pair around bold that runs past a link", () => {
		const markdown = "**see [the doc](./a.md) for `why`**";
		expect(roundTrip(markdown)).toBe(markdown);
	});

	it("is stable across repeated round-trips", () => {
		let markdown = "**Rule: run `realpath` on the file**";
		for (let i = 0; i < 4; i += 1) markdown = roundTrip(markdown);
		expect(markdown).toBe("**Rule: run `realpath` on the file**");
	});

	it("repairs a file already damaged by the old serializer", () => {
		expect(roundTrip("**Rule: run ****`realpath`**** on the file**")).toBe(
			"**Rule: run `realpath` on the file**",
		);
	});
});
