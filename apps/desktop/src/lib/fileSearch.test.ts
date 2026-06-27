import { describe, expect, it } from "vitest";
import { searchWorkspaceFiles } from "./fileSearch";

const files = [
	{ path: "/workspace/src/App.tsx", modified_at: 10 },
	{ path: "/workspace/notes/Agent Memory.md", modified_at: 20 },
	{ path: "/workspace/notes/Agent Search.md", modified_at: 30 },
	{ path: "/workspace/archive/search-notes.markdown", modified_at: 40 },
	{ path: "/workspace/index.html", modified_at: 50 },
	{ path: "/workspace/deep/reference.md", modified_at: 60 },
	{ path: "/workspace/search/reference.md", modified_at: 70 },
];

describe("searchWorkspaceFiles", () => {
	it("returns markdown files from the current snapshot only", () => {
		const results = searchWorkspaceFiles({
			files,
			workspacePath: "/workspace",
			query: "",
		});

		expect(results.map((result) => result.relativePath)).toEqual([
			"search/reference.md",
			"deep/reference.md",
			"archive/search-notes.markdown",
			"notes/Agent Search.md",
			"notes/Agent Memory.md",
		]);
	});

	it("prefers filename matches over path-only matches", () => {
		const results = searchWorkspaceFiles({
			files,
			workspacePath: "/workspace",
			query: "search",
		});

		expect(results.map((result) => result.relativePath)).toEqual([
			"archive/search-notes.markdown",
			"notes/Agent Search.md",
			"search/reference.md",
		]);
	});

	it("matches by relative path when the filename does not match", () => {
		const results = searchWorkspaceFiles({
			files,
			workspacePath: "/workspace",
			query: "deep",
		});

		expect(results.map((result) => result.relativePath)).toEqual([
			"deep/reference.md",
		]);
	});

	it("matches multi-token path and filename queries", () => {
		const results = searchWorkspaceFiles({
			files,
			workspacePath: "/workspace",
			query: "notes agent",
		});

		expect(results.map((result) => result.relativePath)).toEqual([
			"notes/Agent Search.md",
			"notes/Agent Memory.md",
		]);
	});

	it("keeps the current file first when blank-query recency ties", () => {
		const results = searchWorkspaceFiles({
			files: [
				{ path: "/workspace/a.md", modified_at: 10 },
				{ path: "/workspace/b.md", modified_at: 10 },
			],
			workspacePath: "/workspace",
			query: "",
			currentPath: "/workspace/b.md",
		});

		expect(results.map((result) => result.relativePath)).toEqual([
			"b.md",
			"a.md",
		]);
	});

	it("filters results to the selected folder before ranking", () => {
		const results = searchWorkspaceFiles({
			files,
			workspacePath: "/workspace",
			query: "reference",
			folderPath: "/workspace/deep",
		});

		expect(results.map((result) => result.relativePath)).toEqual([
			"deep/reference.md",
		]);
	});
});
