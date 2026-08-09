import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	extractFrontMatterTags,
	FRONT_MATTER_HEAD_BYTES,
	scanFrontMatterTags,
} from "./frontMatterTags";

describe("extractFrontMatterTags", () => {
	it("reads a YAML sequence of tags", () => {
		expect(
			extractFrontMatterTags(
				["---", "tags:", "  - work", "  - meeting", "---", "# Note"].join("\n"),
			),
		).toEqual(["work", "meeting"]);
	});

	it("reads an inline tag list", () => {
		expect(
			extractFrontMatterTags(["---", "tags: [a, b]", "---", ""].join("\n")),
		).toEqual(["a", "b"]);
	});

	it("matches the key case-insensitively", () => {
		expect(
			extractFrontMatterTags(["---", "Tags:", "  - x", "---"].join("\n")),
		).toEqual(["x"]);
	});

	it("returns nothing for files without front matter or without tags", () => {
		expect(extractFrontMatterTags("# Just a heading\n")).toEqual([]);
		expect(
			extractFrontMatterTags(["---", "title: Note", "---", ""].join("\n")),
		).toEqual([]);
		expect(extractFrontMatterTags("")).toEqual([]);
	});

	it("ignores a scalar tags value rather than guessing at it", () => {
		expect(
			extractFrontMatterTags(["---", "tags: work", "---", ""].join("\n")),
		).toEqual([]);
	});

	it("drops blank entries", () => {
		expect(
			extractFrontMatterTags(
				["---", "tags:", "  - work", '  - ""', "---"].join("\n"),
			),
		).toEqual(["work"]);
	});

	it("survives malformed front matter without throwing", () => {
		expect(() =>
			extractFrontMatterTags(["---", "tags: [unclosed", "---"].join("\n")),
		).not.toThrow();
	});
});

describe("scanFrontMatterTags", () => {
	let dir: string;
	const file = (name: string) => path.join(dir, name);

	beforeAll(() => {
		dir = mkdtempSync(path.join(tmpdir(), "mdly-tags-"));
		mkdirSync(path.join(dir, "notes"));
		writeFileSync(
			file("alpha.md"),
			[
				"---",
				"title: Alpha",
				"tags:",
				"  - work",
				"  - meeting",
				"---",
				"# Alpha",
			].join("\n"),
		);
		writeFileSync(
			file("beta.md"),
			["---", "tags: [work, personal]", "---", "# Beta"].join("\n"),
		);
		writeFileSync(
			path.join(dir, "notes", "gamma.md"),
			["---", "tags:", "  - work", "---", "# Gamma"].join("\n"),
		);
		writeFileSync(file("untagged.md"), "# No front matter\n");
		// Front matter followed by a body far larger than the bounded head read,
		// proving the scan cost does not scale with file size.
		writeFileSync(
			file("huge.md"),
			[
				"---",
				"tags:",
				"  - big",
				"---",
				"x".repeat(FRONT_MATTER_HEAD_BYTES * 4),
			].join("\n"),
		);
	});

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("maps real files on disk to their front-matter tags", async () => {
		const result = await scanFrontMatterTags([
			file("alpha.md"),
			file("beta.md"),
			path.join(dir, "notes", "gamma.md"),
			file("untagged.md"),
			file("huge.md"),
		]);

		expect(result[file("alpha.md")]).toEqual(["work", "meeting"]);
		expect(result[file("beta.md")]).toEqual(["work", "personal"]);
		expect(result[path.join(dir, "notes", "gamma.md")]).toEqual(["work"]);
		expect(result[file("huge.md")]).toEqual(["big"]);
		// Files with no tags are omitted rather than mapped to an empty array.
		expect(file("untagged.md") in result).toBe(false);
	});

	it("skips unreadable or missing paths instead of failing the whole scan", async () => {
		const result = await scanFrontMatterTags([
			file("does-not-exist.md"),
			file("alpha.md"),
			dir, // a directory, not a file
		]);

		expect(result[file("alpha.md")]).toEqual(["work", "meeting"]);
		expect(Object.keys(result)).toHaveLength(1);
	});

	it("returns an empty map for no paths", async () => {
		expect(await scanFrontMatterTags([])).toEqual({});
	});
});
