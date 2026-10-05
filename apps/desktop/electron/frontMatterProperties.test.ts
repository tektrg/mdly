import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	extractHeadProperties,
	PROPERTY_HEAD_BYTES,
	scanFrontMatterProperties,
} from "./frontMatterProperties";

describe("extractHeadProperties", () => {
	it("keeps every supported key with the editor's value types", () => {
		const head = [
			"---",
			"status: Todo",
			"priority: 2",
			"done: false",
			"due: 2026-10-05",
			"tags: [work, ideas]",
			"meta:",
			"  nested: true",
			"---",
			"# Body",
		].join("\n");
		expect(extractHeadProperties(head)).toEqual({
			kind: "properties",
			properties: {
				status: { type: "text", value: "Todo" },
				priority: { type: "number", value: 2 },
				done: { type: "checkbox", value: false },
				due: { type: "date", value: "2026-10-05" },
				tags: { type: "tags", value: ["work", "ideas"] },
			},
		});
	});

	it("reports malformed YAML as invalid, not as no properties", () => {
		expect(
			extractHeadProperties(["---", "status: [unclosed", "---", ""].join("\n")),
		).toEqual({ kind: "invalid" });
	});

	it("reports a block cut off by the head read as invalid", () => {
		const head = `---\n${"k: v\n".repeat(PROPERTY_HEAD_BYTES)}`.slice(
			0,
			PROPERTY_HEAD_BYTES,
		);
		expect(extractHeadProperties(head)).toEqual({ kind: "invalid" });
	});

	it("reads a file saved with a BOM and CRLF line endings", () => {
		expect(
			extractHeadProperties("\uFEFF---\r\nstatus: x\r\n---\r\nbody"),
		).toEqual({
			kind: "properties",
			properties: { status: { type: "text", value: "x" } },
		});
	});

	it("returns none for a file without front matter", () => {
		expect(extractHeadProperties("# Just a note\n")).toEqual({ kind: "none" });
	});
});

describe("scanFrontMatterProperties", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(path.join(tmpdir(), "mdly-props-"));
		writeFileSync(path.join(dir, "a.md"), "---\nstatus: Done\n---\nbody");
		writeFileSync(path.join(dir, "bad.md"), "---\na: [\n---\n");
		writeFileSync(path.join(dir, "plain.md"), "no front matter");
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("maps files to properties, lists the malformed, skips missing files", async () => {
		const result = await scanFrontMatterProperties([
			path.join(dir, "a.md"),
			path.join(dir, "bad.md"),
			path.join(dir, "plain.md"),
			path.join(dir, "missing.md"),
		]);
		expect(result.propertiesByPath).toEqual({
			[path.join(dir, "a.md")]: { status: { type: "text", value: "Done" } },
		});
		expect(result.invalidPaths).toEqual([path.join(dir, "bad.md")]);
	});
});
