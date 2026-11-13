import { describe, expect, it } from "vitest";
import type { FileEntry } from "../store/state";
import {
	backlinksFor,
	createLinkIndex,
	resolveWikiTarget,
	setLinkSource,
} from "./linkIndex";
import { resolveWikiPath } from "./wikiPath";

const ROOT = "/ws";
const files = (paths: string[]): FileEntry[] =>
	paths.map((path) => ({ path, modified_at: 1 }));

function click(target: string, paths: string[], source = "/ws/a/src.md") {
	return resolveWikiPath({
		target,
		files: files(paths),
		workspacePath: ROOT,
		sourcePath: source,
	});
}

describe("resolveWikiPath (editor click)", () => {
	it("matches the name case-insensitively", () => {
		expect(click("note", ["/ws/z/Note.md"])).toBe("/ws/z/Note.md");
	});

	it("prefers the source folder, then shortest path, then A-Z", () => {
		const dupes = ["/ws/b/deep/Note.md", "/ws/c/Note.md", "/ws/a/Note.md"];
		expect(click("Note", dupes)).toBe("/ws/a/Note.md");
		expect(click("Note", dupes, "/ws/x/src.md")).toBe("/ws/a/Note.md");
		expect(
			click("Note", ["/ws/bb/Note.md", "/ws/b/deep/Note.md"], "/ws/x/s.md"),
		).toBe("/ws/bb/Note.md");
	});

	it("resolves path targets from the root, then the source folder", () => {
		const paths = ["/ws/sub/Note.md", "/ws/a/sub/Note.md"];
		expect(click("sub/note", paths)).toBe("/ws/sub/Note.md");
		expect(click("sub/Note", ["/ws/a/sub/Note.md"])).toBe("/ws/a/sub/Note.md");
	});

	it("ignores #section and keeps unicode and dotted names", () => {
		expect(click("Ghi chú#Phần 1", ["/ws/Ghi chú.md"])).toBe("/ws/Ghi chú.md");
		expect(click("v1.2 notes", ["/ws/q/v1.2 notes.md"])).toBe(
			"/ws/q/v1.2 notes.md",
		);
	});

	it("falls back to the root-joined path when nothing matches", () => {
		expect(click("Missing", [])).toBe("/ws/Missing.md");
	});
});

describe("click and Backlinks agree", () => {
	it.each([
		"Note",
		"note",
		"NOTE#sec",
		"sub/Note",
		"a/sub/note",
	])("%s", (target) => {
		const paths = [
			"/ws/a/src.md",
			"/ws/a/Note.md",
			"/ws/c/Note.md",
			"/ws/sub/Note.md",
			"/ws/a/sub/Note.md",
		];
		const index = createLinkIndex(ROOT);
		for (const p of paths)
			setLinkSource(index, p, p.endsWith("src.md") ? `[[${target}]]` : "", 1);
		const indexed = resolveWikiTarget(
			index,
			"/ws/a/src.md",
			target.split("#")[0] as string,
		);
		expect(click(target, paths)).toBe(indexed);
		expect(
			backlinksFor(index, indexed as string).map((b) => b.sourcePath),
		).toEqual(["/ws/a/src.md"]);
	});
});

describe("resolveWikiPath table-escaped alias", () => {
	it("drops a \\| alias like a plain | alias", () => {
		expect(click("Note\\|alias", ["/ws/z/Note.md"])).toBe("/ws/z/Note.md");
	});
});
