import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { findMatches } from "./FindExtension";

const schema = new Schema({
	nodes: {
		doc: { content: "paragraph+" },
		paragraph: {
			content: "text*",
			group: "block",
			parseDOM: [{ tag: "p" }],
			toDOM: () => ["p", 0],
		},
		text: { group: "inline" },
	},
});

describe("findMatches", () => {
	it("finds case-insensitive text-node matches", () => {
		const doc = schema.node("doc", null, [
			schema.node("paragraph", null, schema.text("Alpha beta alpha")),
			schema.node("paragraph", null, schema.text("Alphabet")),
		]);

		expect(findMatches(doc, "alpha")).toEqual([
			{ from: 1, to: 6 },
			{ from: 12, to: 17 },
			{ from: 19, to: 24 },
		]);
	});

	it("returns no matches for an empty query", () => {
		const doc = schema.node("doc", null, [
			schema.node("paragraph", null, schema.text("Alpha")),
		]);

		expect(findMatches(doc, "")).toEqual([]);
	});
});
