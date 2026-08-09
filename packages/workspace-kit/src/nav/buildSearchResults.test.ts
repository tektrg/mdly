import { describe, expect, it } from "vitest";
import { buildSearchResults } from "./buildSearchResults";
import type { SidebarFile } from "./useSidebarTree";

/** mdly-shaped host: display path is the workspace-relative path. */
const relative = (path: string) => path.replace(/^\/workspace\//, "");

describe("buildSearchResults", () => {
	it("ranks a file-name match above a match found only in the folder path", () => {
		const files: SidebarFile[] = [
			{ path: "/workspace/sync/report.md" }, // "sync" is only the folder
			{ path: "/workspace/notes/sync.md" }, // "sync" is the file name
		];

		expect(
			buildSearchResults({
				files,
				query: "sync",
				getDisplayPath: relative,
			}).map((result) => result.label),
		).toEqual(["sync.md", "report.md"]);
	});

	it("matches the title a host shows, even when the filename does not contain the query", () => {
		// SpeechToDo-shaped host: getDisplayPath returns the recording's title,
		// which has nothing in common with the timestamped file on disk.
		const titles = new Map([
			["/w/2026-08-08T0912.m4a", "Quarterly planning with Mai"],
			["/w/2026-08-07T1730.m4a", "Grocery list"],
		]);
		const files: SidebarFile[] = [...titles.keys()].map((path) => ({ path }));

		const results = buildSearchResults({
			files,
			query: "quarterly",
			getDisplayPath: (path) => titles.get(path) ?? path,
		});

		expect(results).toHaveLength(1);
		expect(results[0]?.label).toBe("Quarterly planning with Mai");
	});

	it("still finds a file by its on-disk name when the title does not match", () => {
		const files: SidebarFile[] = [{ path: "/w/2026-08-08T0912.m4a" }];

		expect(
			buildSearchResults({
				files,
				query: "20260808",
				getDisplayPath: () => "Quarterly planning",
			}),
		).toHaveLength(1);
	});

	it("ignores spacing and punctuation on both sides", () => {
		const files: SidebarFile[] = [{ path: "/workspace/notes/My_Project.md" }];

		for (const query of ["myproject", "My Project", "my-project"]) {
			expect(
				buildSearchResults({ files, query, getDisplayPath: relative }),
			).toHaveLength(1);
		}
	});

	it("ranks a substring match above a scattered-letter one", () => {
		const files: SidebarFile[] = [
			{ path: "/workspace/my true guide.md" }, // "mtg" scattered
			{ path: "/workspace/mtg recap.md" }, // "mtg" literal
		];

		expect(
			buildSearchResults({
				files,
				query: "mtg",
				getDisplayPath: relative,
			}).map((result) => result.label),
		).toEqual(["mtg recap.md", "my true guide.md"]);
	});

	it("drops files that do not match at all", () => {
		const files: SidebarFile[] = [
			{ path: "/workspace/alpha.md" },
			{ path: "/workspace/beta.md" },
		];

		expect(
			buildSearchResults({ files, query: "zzzz", getDisplayPath: relative }),
		).toEqual([]);
	});

	it("returns every file for a blank query, so callers need no special case", () => {
		const files: SidebarFile[] = [
			{ path: "/workspace/alpha.md" },
			{ path: "/workspace/beta.md" },
		];

		expect(
			buildSearchResults({ files, query: "", getDisplayPath: relative }),
		).toHaveLength(2);
	});

	it("breaks ties toward the current file, then most recently modified", () => {
		// Same label, so both score identically and only the tie-breaks decide.
		const files: SidebarFile[] = [
			{ path: "/workspace/a/note.md", modifiedAt: 1 },
			{ path: "/workspace/b/note.md", modifiedAt: 500 },
		];

		expect(
			buildSearchResults({
				files,
				query: "note",
				getDisplayPath: relative,
			}).map((result) => result.file.path),
		).toEqual(["/workspace/b/note.md", "/workspace/a/note.md"]);

		expect(
			buildSearchResults({
				files,
				query: "note",
				getDisplayPath: relative,
				currentPath: "/workspace/a/note.md",
			}).map((result) => result.file.path),
		).toEqual(["/workspace/a/note.md", "/workspace/b/note.md"]);
	});

	it("sorts files with no modified time last rather than at random", () => {
		const files: SidebarFile[] = [
			{ path: "/workspace/a/note.md" },
			{ path: "/workspace/b/note.md", modifiedAt: 10 },
		];

		expect(
			buildSearchResults({
				files,
				query: "note",
				getDisplayPath: relative,
			}).map((result) => result.file.path),
		).toEqual(["/workspace/b/note.md", "/workspace/a/note.md"]);
	});

	it("does not truncate -- every match is returned", () => {
		const files: SidebarFile[] = Array.from({ length: 500 }, (_, i) => ({
			path: `/workspace/note-${i}.md`,
		}));

		expect(
			buildSearchResults({ files, query: "note", getDisplayPath: relative }),
		).toHaveLength(500);
	});
});
