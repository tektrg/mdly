import { describe, expect, it } from "vitest";
import {
	backlinksFor,
	createLinkIndex,
	extractMarkdownLinks,
	linkGraph,
	outgoingFor,
	removeLinkSource,
	renameLinkSource,
	setLinkSource,
} from "./linkIndex";

describe("extractMarkdownLinks", () => {
	it("resolves relative .md links from the source's folder, keeping the anchor", () => {
		const links = extractMarkdownLinks(
			"/ws/notes/a.md",
			"See [B](../b.md#intro) and [C](sub/c.md).",
		);
		expect(links.map((l) => [l.targetPath, l.anchor])).toEqual([
			["/ws/b.md", "intro"],
			["/ws/notes/sub/c.md", null],
		]);
		expect(links[0]?.line).toBe(1);
		expect(links[0]?.snippet).toBe("See [B](../b.md#intro) and [C](sub/c.md).");
	});

	it("ignores images, external URLs, absolute paths, non-markdown and same-doc anchors", () => {
		const content = [
			"![img](pic.md)",
			"[web](https://x.com/a.md)",
			"[mail](mailto:a@b.c)",
			"[abs](/etc/a.md)",
			"[pdf](doc.pdf)",
			"[self](#heading)",
			"[[wiki]]",
		].join("\n");
		expect(extractMarkdownLinks("/ws/a.md", content)).toEqual([]);
	});

	it("ignores links inside fenced and inline code", () => {
		const content = [
			"```md",
			"[in fence](b.md)",
			"```",
			"~~~",
			"[tilde](b.md)",
			"~~~",
			"text `[inline](b.md)` [real](c.md)",
		].join("\n");
		const links = extractMarkdownLinks("/ws/a.md", content);
		expect(links.map((l) => l.targetPath)).toEqual(["/ws/c.md"]);
		expect(links[0]?.line).toBe(7);
	});

	it("handles titles, angle brackets and percent-encoding", () => {
		const links = extractMarkdownLinks(
			"/ws/a.md",
			'[t](b.md "Title") [s](<my note.md>) [e](my%20other.md)',
		);
		expect(links.map((l) => l.targetPath)).toEqual([
			"/ws/b.md",
			"/ws/my note.md",
			"/ws/my other.md",
		]);
	});

	it("trims long snippets around the link", () => {
		const long = `${"x".repeat(300)} [b](b.md) ${"y".repeat(300)}`;
		const [link] = extractMarkdownLinks("/ws/a.md", long);
		expect(link?.snippet.length).toBeLessThanOrEqual(162);
		expect(link?.snippet).toContain("[b](b.md)");
	});
});

describe("link index", () => {
	it("tracks backlinks and outgoing links, case-insensitively", () => {
		const index = createLinkIndex();
		setLinkSource(index, "/ws/a.md", "[b](B.md) [b again](b.md#x)", 1);
		setLinkSource(index, "/ws/c.md", "[b](b.md)", 1);
		expect(backlinksFor(index, "/ws/b.md").map((b) => b.sourcePath)).toEqual([
			"/ws/a.md",
			"/ws/a.md",
			"/ws/c.md",
		]);
		expect(outgoingFor(index, "/ws/a.md")).toHaveLength(2);
	});

	it("never lists a document as its own backlink", () => {
		const index = createLinkIndex();
		setLinkSource(index, "/ws/a.md", "[me](a.md)", 1);
		expect(backlinksFor(index, "/ws/a.md")).toEqual([]);
	});

	it("updates incrementally on edit, delete and rename", () => {
		const index = createLinkIndex();
		setLinkSource(index, "/ws/a.md", "[b](b.md)", 1);
		setLinkSource(index, "/ws/a.md", "[c](c.md)", 2);
		expect(backlinksFor(index, "/ws/b.md")).toEqual([]);
		expect(backlinksFor(index, "/ws/c.md")).toHaveLength(1);

		renameLinkSource(index, "/ws/a.md", "/ws/z.md");
		expect(backlinksFor(index, "/ws/c.md")[0]?.sourcePath).toBe("/ws/z.md");

		removeLinkSource(index, "/ws/z.md");
		expect(backlinksFor(index, "/ws/c.md")).toEqual([]);
		expect(index.sources.size).toBe(0);
	});

	it("re-resolves a renamed source's relative links from its new folder", () => {
		const index = createLinkIndex();
		setLinkSource(index, "/ws/a.md", "[b](b.md)", 1);
		renameLinkSource(index, "/ws/a.md", "/ws/sub/a.md", "[b](../b.md)");
		expect(backlinksFor(index, "/ws/b.md")[0]?.sourcePath).toBe("/ws/sub/a.md");
	});

	it("builds a deduplicated graph restricted to a set of files", () => {
		const index = createLinkIndex();
		setLinkSource(index, "/ws/a.md", "[b](b.md) [b](b.md) [gone](gone.md)", 1);
		setLinkSource(index, "/ws/b.md", "[a](a.md)", 1);
		const graph = linkGraph(index, ["/ws/a.md", "/ws/b.md", "/ws/lonely.md"]);
		expect(graph.nodes).toEqual(["/ws/a.md", "/ws/b.md", "/ws/lonely.md"]);
		expect(graph.edges).toEqual([
			{ source: "/ws/a.md", target: "/ws/b.md", count: 2 },
			{ source: "/ws/b.md", target: "/ws/a.md", count: 1 },
		]);
	});
});
