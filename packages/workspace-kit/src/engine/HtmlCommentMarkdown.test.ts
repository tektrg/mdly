import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import {
	htmlCommentText,
	validateHtmlCommentText,
	withHtmlCommentText,
} from "./HtmlComment";
import { markdownToTiptapDoc } from "./markdownToProsemirror";
import { tiptapDocToMarkdown } from "./prosemirrorToMarkdown";

const AGENT_NOTE =
	"<!-- CHECKED 2026-11-13: Nuclino lists views, properties, formula/rollup chains as slowdown causes (vendor page; ends in a Nuclino pitch) -->";

function roundTrip(markdown: string): string {
	return tiptapDocToMarkdown(markdownToTiptapDoc(markdown));
}

function collect(node: JSONContent, type: string, out: JSONContent[] = []) {
	if (node.type === type) out.push(node);
	for (const child of node.content ?? []) collect(child, type, out);
	return out;
}

const comments = (markdown: string) =>
	collect(markdownToTiptapDoc(markdown), "htmlComment");
const blockComments = (markdown: string) =>
	collect(markdownToTiptapDoc(markdown), "htmlCommentBlock");

describe("inline HTML comments (primary case)", () => {
	const cases: Record<string, string> = {
		paragraph: `Claim X. ${AGENT_NOTE} Next sentence.`,
		"paragraph start": "<!-- n --> text after",
		"two in a row": "a <!-- one --><!-- two --> b",
		"bullet list item": `- Claim X. ${AGENT_NOTE} Next.\n- two`,
		"ordered list item": "1. one <!-- n --> tail\n2. two",
		"task item": "- [ ] todo <!-- why --> later",
		"nested list item": "- outer\n  - inner <!-- n --> x",
		"table cell": `| a | b |\n| --- | --- |\n| x ${AGENT_NOTE} | y |`,
		"table cell with pipe escape": "| a |\n| --- |\n| x <!-- a \\| b --> |",
		"inside bold": "**bold <!-- n --> still**",
		"inside link text": "[label <!-- n -->](https://e.com)",
		heading: "## Title <!-- n -->",
		"multi-line in paragraph": "Claim <!-- line one\nline two --> after",
		"whitespace kept": "a <!--   spaced\t-->b",
		"no inner spaces": "a <!--tight--> b",
		"after heading": "# H\n\nPara <!-- n --> x",
		"inside columns": "::: columns\nleft <!-- n --> x\n+++\nright\n:::",
		blockquote: "> quoted <!-- n --> x",
	};
	for (const [name, md] of Object.entries(cases)) {
		it(`round-trips byte-identically: ${name}`, () => {
			expect(roundTrip(md)).toBe(md);
		});
	}

	it("parses into an atom node, not visible text", () => {
		const doc = markdownToTiptapDoc(`Claim X. ${AGENT_NOTE} Next sentence.`);
		expect(doc.content?.[0]).toEqual({
			type: "paragraph",
			content: [
				{ type: "text", text: "Claim X. " },
				{ type: "htmlComment", attrs: { raw: AGENT_NOTE } },
				{ type: "text", text: " Next sentence." },
			],
		});
	});

	it("is a node inside list items and table cells", () => {
		expect(comments("- a <!-- n --> b")).toHaveLength(1);
		expect(comments("| a |\n| --- |\n| x <!-- n --> |")).toHaveLength(1);
		expect(comments("::: columns\nl <!-- n -->\n+++\nr\n:::")).toHaveLength(1);
	});
});

describe("block HTML comments", () => {
	const cases: Record<string, string> = {
		single: AGENT_NOTE,
		"multi-line": "<!--\nline one\n  indented two\n-->",
		"between heading and paragraph": "# H\n\n<!-- n -->\n\nPara",
		"before a list": "<!-- n -->\n\n- a\n- b",
		"after a list": "- a\n- b\n\n<!-- n -->",
		"in list item body": "- a\n  <!-- n -->",
		"inside columns": "::: columns\n<!-- n -->\n+++\nright\n:::",
		"followed by text on the same line": "<!-- n --> trailing words",
	};
	for (const [name, md] of Object.entries(cases)) {
		it(`round-trips byte-identically: ${name}`, () => {
			expect(roundTrip(md)).toBe(md);
		});
	}

	it("directly under a heading: kept in place, blank line normalised like any block", () => {
		// The serializer always separates top-level blocks with one blank line;
		// that pre-dates comment support and applies to every block type.
		const once = roundTrip("# H\n<!-- n -->\n\nPara");
		expect(once).toBe("# H\n\n<!-- n -->\n\nPara");
		expect(roundTrip(once)).toBe(once);
	});

	it("a comment alone on its lines becomes a block marker", () => {
		expect(blockComments("<!--\nmulti\n-->")).toEqual([
			{ type: "htmlCommentBlock", attrs: { raw: "<!--\nmulti\n-->" } },
		]);
		expect(blockComments("# H\n\n<!-- n -->")).toHaveLength(1);
	});
});

describe("code exclusion", () => {
	it("keeps comments in inline code as code text", () => {
		const md = "use `<!-- x -->` here";
		expect(comments(md)).toHaveLength(0);
		expect(roundTrip(md)).toBe(md);
	});
	it("keeps comments in fenced code as code text", () => {
		const md = "```html\n<!-- x -->\n<p>a</p>\n```";
		expect(comments(md)).toHaveLength(0);
		expect(blockComments(md)).toHaveLength(0);
		expect(roundTrip(md)).toBe(md);
	});
	it("keeps mermaid comments inside the diagram source", () => {
		const md = "```mermaid\ngraph TD\n%% <!-- x -->\nA-->B\n```";
		expect(comments(md)).toHaveLength(0);
		expect(roundTrip(md)).toBe(md);
	});
});

describe("existing HTML uses keep working", () => {
	it("notion empty blocks", () => {
		const doc = markdownToTiptapDoc("<empty-block/>");
		expect(doc.content?.[0]?.type).toBe("notionEmptyBlock");
	});
	it("details toggles containing a comment", () => {
		const md = "<details>\n<summary>S</summary>\n<!-- n -->\n</details>";
		expect(markdownToTiptapDoc(md).content?.[0]?.type).toBe("toggle");
	});
	it("iframe embeds", () => {
		const md = '<iframe src="https://e.com/x"></iframe>';
		expect(markdownToTiptapDoc(md).content?.[0]?.type).toBe("embed");
		expect(roundTrip(md)).toBe(md);
	});
	it("callouts", () => {
		const md = "<callout>\nInside\n</callout>";
		expect(markdownToTiptapDoc(md).content?.[0]?.type).toBe("notionCallout");
	});
	it("<br> in table cells", () => {
		const md = "| a |\n| --- |\n| x<br>y |";
		expect(roundTrip(md)).toBe(md);
	});
	it("other raw HTML still falls back to visible text", () => {
		const md = "<div>hi</div>";
		expect(roundTrip(md)).toBe(md);
		expect(comments(md)).toHaveLength(0);
	});
});

describe("comment text helpers", () => {
	it("reads the trimmed note text", () => {
		expect(htmlCommentText("<!--  a\n b  -->")).toBe("a\n b");
	});
	it("rejects --> and --!> in edited text", () => {
		expect(validateHtmlCommentText("a --> b")).not.toBeNull();
		expect(validateHtmlCommentText("a --!> b")).not.toBeNull();
		expect(validateHtmlCommentText("fine -> ok")).toBeNull();
	});
	it("keeps the original padding when editing", () => {
		expect(withHtmlCommentText("<!-- old -->", "new")).toBe("<!-- new -->");
		expect(withHtmlCommentText("<!--old-->", "new")).toBe("<!--new-->");
		expect(withHtmlCommentText("<!--\nold\n-->", "a\nb")).toBe(
			"<!--\na\nb\n-->",
		);
	});
	it("guards text that would close the comment early", () => {
		expect(withHtmlCommentText("<!--old-->", ">x")).toBe("<!-- >x-->");
		expect(withHtmlCommentText("<!--old-->", "x-")).toBe("<!--x- -->");
	});
});
