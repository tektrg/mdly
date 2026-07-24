import { describe, expect, it } from "vitest";
import { markdownToTiptapDoc } from "./markdownToProsemirror";
import { tiptapDocToMarkdown } from "./prosemirrorToMarkdown";

describe("mermaid block markdown conversion", () => {
	it("maps a mermaid fence to a mermaidBlock node", () => {
		const doc = markdownToTiptapDoc("```mermaid\ngraph TD;\n  A-->B;\n```");

		expect(doc.content?.[0]).toEqual({
			type: "mermaidBlock",
			attrs: { raw: "graph TD;\n  A-->B;" },
		});
	});

	it("round-trips a mermaid fence identically", () => {
		const markdown = "```mermaid\ngraph TD;\n  A-->B;\n```";

		expect(tiptapDocToMarkdown(markdownToTiptapDoc(markdown))).toBe(markdown);
	});

	it("keeps non-mermaid fenced blocks as code blocks", () => {
		const doc = markdownToTiptapDoc("```ts\nconst x = 1;\n```");

		expect(doc.content?.[0]?.type).toBe("codeBlock");
	});
});
