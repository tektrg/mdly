import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MDLY_AUTHORING_NOTES } from "./authoringNotes";

// The kit's copy is the one checked against the Markdown parser; read it as
// text so the CLI build doesn't pull the kit in.
const kitSource = readFileSync(
	new URL("../../workspace-kit/src/engine/authoringNotes.ts", import.meta.url),
	"utf8",
);

describe("CLI authoring notes", () => {
	it("match the kit's MDLY_AUTHORING_NOTES", () => {
		const cliSource = readFileSync(
			new URL("./authoringNotes.ts", import.meta.url),
			"utf8",
		);
		const literal = (source: string) =>
			source.slice(source.indexOf("export const MDLY_AUTHORING_NOTES"));
		expect(literal(cliSource)).toBe(literal(kitSource));
		expect(MDLY_AUTHORING_NOTES).toContain("::: columns");
	});
});
