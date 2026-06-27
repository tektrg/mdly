// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { combineFindReplaceMatches } from "./FindReplaceBar";

describe("combineFindReplaceMatches", () => {
	it("orders properties before body matches to follow rendered file order", () => {
		expect(
			combineFindReplaceMatches(
				[{ from: 10, to: 15, text: "alpha" }],
				[{ from: 0, to: 5, text: "alpha" }],
			),
		).toEqual([
			{ scope: "frontMatter", match: { from: 0, to: 5, text: "alpha" } },
			{ scope: "body", match: { from: 10, to: 15, text: "alpha" } },
		]);
	});
});
