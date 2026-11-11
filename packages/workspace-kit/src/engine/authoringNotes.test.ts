import { describe, expect, it } from "vitest";
import { MDLY_AUTHORING_NOTES } from "./authoringNotes";
import { markdownToTiptapDoc } from "./markdownToProsemirror";

const types = (md: string) =>
	(markdownToTiptapDoc(md).content ?? []).map((node) => node.type);

describe("MDLY_AUTHORING_NOTES examples match the parser", () => {
	it("stays short", () => {
		expect(MDLY_AUTHORING_NOTES.split("\n").length).toBeLessThanOrEqual(16);
	});

	it.each([
		["![Chart|400](images/chart.png)", ["image"], "|400"],
		["![Chart|400x300](images/chart.png)", ["image"], "|400x300"],
		["::: columns 2:1\nLeft\n+++\nRight\n:::", ["columns"], "::: columns"],
		[
			'<iframe src="https://www.youtube.com/embed/ID" width="100%" height="480"></iframe>',
			["embed"],
			"<iframe",
		],
		["```mermaid\ngraph TD; A-->B\n```", ["mermaidBlock"], "```mermaid"],
	])("%s", (markdown, expected, mention) => {
		expect(types(markdown)).toEqual(expected);
		expect(MDLY_AUTHORING_NOTES).toContain(mention);
	});

	it("documents that http iframes are rejected", () => {
		expect(types('<iframe src="http://a.com"></iframe>')).toEqual([
			"paragraph",
		]);
		expect(MDLY_AUTHORING_NOTES).toMatch(/http/);
	});
});
