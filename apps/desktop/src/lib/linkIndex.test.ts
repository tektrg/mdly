import { describe, expect, it } from "vitest";
import { normalizePath } from "./filePath";
import {
	backlinksFor,
	batchLinkIndex,
	createLinkIndex,
	extractMarkdownLinks,
	linkGraph,
	outgoingFor,
	pathKey,
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

describe("linkGraph case-insensitive nodes", () => {
	it("dedupes node paths that differ only by case", () => {
		const index = createLinkIndex();
		setLinkSource(index, "/ws/a.md", "[b](b.md)", 1);
		const graph = linkGraph(index, ["/ws/a.md", "/ws/A.md", "/ws/b.md"]);
		expect(graph.nodes).toEqual(["/ws/a.md", "/ws/b.md"]);
		expect(graph.edges).toEqual([
			{ source: "/ws/a.md", target: "/ws/b.md", count: 1 },
		]);
	});
});

describe("extractMarkdownLinks edge forms", () => {
	it("resolves reference-style links via their definitions, snippet from the usage line", () => {
		const content = [
			"See [the plan][p] and [Notes][] and [shortcut].",
			"Unused [x][missing].",
			"",
			"[p]: ./plan.md#goals",
			'[notes]: <../my notes.md> "Title"',
			"[shortcut]: sub/s%20c.md",
			"[unused]: other.md",
			"```",
			"[q][p]",
			"```",
		].join("\n");
		const links = extractMarkdownLinks("/ws/d/a.md", content);
		expect(links.map((l) => [l.targetPath, l.anchor, l.line])).toEqual([
			["/ws/d/plan.md", "goals", 1],
			["/ws/my notes.md", null, 1],
			["/ws/d/sub/s c.md", null, 1],
		]);
		expect(links[0]?.snippet).toBe(
			"See [the plan][p] and [Notes][] and [shortcut].",
		);
	});

	it("decodes %20 and accepts angle-bracket destinations with spaces", () => {
		const links = extractMarkdownLinks(
			"/ws/a.md",
			"[a](my%20doc.md) [b](<./other doc.md#x>)",
		);
		expect(links.map((l) => [l.targetPath, l.anchor])).toEqual([
			["/ws/my doc.md", null],
			["/ws/other doc.md", "x"],
		]);
	});
});

describe("wiki links", () => {
	const build = (files: Record<string, string>, root = "/ws") => {
		const index = createLinkIndex(root);
		for (const [p, content] of Object.entries(files))
			setLinkSource(index, `/ws/${p}`, content, 1);
		return index;
	};
	const targets = (index: ReturnType<typeof build>, p: string) =>
		outgoingFor(index, `/ws/${p}`).map((l) => [l.targetPath, l.anchor]);

	it("resolves every syntax variant to Note.md", () => {
		const index = build({
			"folder/Note.md": "",
			"src.md": [
				"[[Note]]",
				"[[Note|alias]]",
				"[[Note#Section]]",
				"[[folder/Note]]",
				"[[Note.md]]",
				"[[note|x#y]]",
			].join("\n"),
		});
		expect(targets(index, "src.md")).toEqual([
			["/ws/folder/Note.md", null],
			["/ws/folder/Note.md", null],
			["/ws/folder/Note.md", "Section"],
			["/ws/folder/Note.md", null],
			["/ws/folder/Note.md", null],
			["/ws/folder/Note.md", null],
		]);
		expect(outgoingFor(index, "/ws/src.md")[2]?.line).toBe(3);
	});

	it("ignores embeds, non-md targets, unresolved targets and code", () => {
		const index = build({
			"img.png": "",
			"Note.md": "",
			"src.md": [
				"![[Note]] ![[img.png]] [[img.png]] [[Missing]]",
				"```",
				"[[Note]]",
				"```",
				"text `[[Note]]` here",
			].join("\n"),
		});
		expect(targets(index, "src.md")).toEqual([]);
	});

	it("resolves path targets from the root, then from the source folder", () => {
		const index = build({
			"a/Note.md": "",
			"sub/a/Note.md": "",
			"sub/b/Other.md": "",
			"sub/src.md": "[[a/Note]] [[b/Other]] [[../a/Note]] [[x/Note]]",
		});
		expect(targets(index, "sub/src.md")).toEqual([
			["/ws/a/Note.md", null],
			["/ws/sub/b/Other.md", null],
			["/ws/a/Note.md", null],
		]);
	});

	it("picks among duplicate names: same folder, then shortest path, then A→Z", () => {
		const order = (files: Record<string, string>, src: string) => {
			const a = build(files);
			const b = build(Object.fromEntries(Object.entries(files).reverse()));
			expect(targets(a, src)).toEqual(targets(b, src));
			return targets(a, src)[0]?.[0];
		};
		const deep = { "x/y/Note.md": "", "z/Note.md": "" };
		expect(order({ ...deep, "x/y/src.md": "[[note]]" }, "x/y/src.md")).toBe(
			"/ws/x/y/Note.md",
		);
		expect(order({ ...deep, "src.md": "[[Note]]" }, "src.md")).toBe(
			"/ws/z/Note.md",
		);
		expect(
			order(
				{ "b/Note.md": "", "a/Note.md": "", "src.md": "[[Note]]" },
				"src.md",
			),
		).toBe("/ws/a/Note.md");
	});

	it("re-resolves when a same-named file is added, renamed or deleted", () => {
		const index = build({ "src.md": "[[Note]]", "deep/er/Note.md": "" });
		const back = (p: string) =>
			backlinksFor(index, `/ws/${p}`).map((b) => b.sourcePath);
		expect(back("deep/er/Note.md")).toEqual(["/ws/src.md"]);

		// Added later, shorter path: wins.
		setLinkSource(index, "/ws/z/Note.md", "", 1);
		expect(back("z/Note.md")).toEqual(["/ws/src.md"]);
		expect(back("deep/er/Note.md")).toEqual([]);

		// Renamed away from the name: falls back to the remaining namesake.
		renameLinkSource(index, "/ws/z/Note.md", "/ws/z/Other.md");
		expect(back("deep/er/Note.md")).toEqual(["/ws/src.md"]);
		expect(back("z/Other.md")).toEqual([]);

		// Renamed onto the name in the source's own folder: wins.
		renameLinkSource(index, "/ws/z/Other.md", "/ws/note.md");
		expect(back("note.md")).toEqual(["/ws/src.md"]);

		// Deleted: back to the other one; then all gone → unresolved.
		removeLinkSource(index, "/ws/note.md");
		expect(back("deep/er/Note.md")).toEqual(["/ws/src.md"]);
		removeLinkSource(index, "/ws/deep/er/Note.md");
		expect(outgoingFor(index, "/ws/src.md")).toEqual([]);
		expect(index.incoming.size).toBe(0);

		// A target indexed after its linker still resolves.
		setLinkSource(index, "/ws/late/Note.md", "", 1);
		expect(back("late/Note.md")).toEqual(["/ws/src.md"]);
	});

	it("re-resolves a moved source's own wiki links from its new folder", () => {
		const index = build({
			"a/Note.md": "",
			"b/Note.md": "",
			"a/src.md": "[[Note]]",
		});
		expect(targets(index, "a/src.md")).toEqual([["/ws/a/Note.md", null]]);
		renameLinkSource(index, "/ws/a/src.md", "/ws/b/src.md");
		expect(targets(index, "b/src.md")).toEqual([["/ws/b/Note.md", null]]);
		expect(backlinksFor(index, "/ws/a/Note.md")).toEqual([]);
	});

	it("feeds backlinks and the graph next to Markdown links", () => {
		const index = build({
			"Note.md": "",
			"src.md": "[md](Note.md)\n[[Note|wiki]]",
		});
		expect(
			backlinksFor(index, "/ws/Note.md").map((b) => [b.sourcePath, b.line]),
		).toEqual([
			["/ws/src.md", 1],
			["/ws/src.md", 2],
		]);
		expect(linkGraph(index, ["/ws/src.md", "/ws/Note.md"]).edges).toEqual([
			{ source: "/ws/src.md", target: "/ws/Note.md", count: 2 },
		]);
	});
});

describe("wiki alias escaped in a GFM table", () => {
	it("treats [[Note\\|alias]] as an alias of Note", () => {
		const index = createLinkIndex("/ws");
		setLinkSource(index, "/ws/folder/Note.md", "", 1);
		setLinkSource(
			index,
			"/ws/src.md",
			"| a | b |\n| --- | --- |\n| [[Note\\|alias]] | [[Note#Sec\\|x]] |",
			1,
		);
		expect(
			outgoingFor(index, "/ws/src.md").map((l) => [l.targetPath, l.anchor]),
		).toEqual([
			["/ws/folder/Note.md", null],
			["/ws/folder/Note.md", "Sec"],
		]);
	});
});

describe("batchLinkIndex", () => {
	it("defers namesake re-resolution to the outermost end", () => {
		const index = createLinkIndex("/ws");
		setLinkSource(index, "/ws/src.md", "[[Note]]", 1);
		setLinkSource(index, "/ws/deep/x/Note.md", "", 1);
		const outer = batchLinkIndex(index);
		const inner = batchLinkIndex(index);
		setLinkSource(index, "/ws/Note.md", "", 1);
		inner();
		expect(backlinksFor(index, "/ws/deep/x/Note.md")).toHaveLength(1);
		outer();
		expect(backlinksFor(index, "/ws/deep/x/Note.md")).toEqual([]);
		expect(backlinksFor(index, "/ws/Note.md")).toHaveLength(1);
	});
});

describe("pathKey fast path", () => {
	it("matches the full normalization for every path shape", () => {
		for (const path of [
			"/",
			"/ws/A.md",
			"/ws//a.md",
			"/ws/./a.md",
			"/ws/x/../a.md",
			"/ws/a/",
			"/ws/.hidden/a.md",
			"/ws/..a/b.md",
			"/ws/a/..",
			"/ws/a/.",
			"C:\\ws\\a.md",
			"/ws\\a.md",
			"rel/./a.md",
		])
			expect(pathKey(path)).toBe(normalizePath(path).toLocaleLowerCase());
	});
});
