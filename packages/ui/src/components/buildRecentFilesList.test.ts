import { describe, expect, it } from "vitest";
import {
	buildRecentFilesList,
	RECENT_FILES_LIMIT,
} from "./buildRecentFilesList";
import type { SidebarFile } from "./useSidebarTree";

function file(path: string, modifiedAt?: number): SidebarFile {
	return { path, modifiedAt };
}

describe("buildRecentFilesList", () => {
	it("sorts by modifiedAt descending", () => {
		const files = [file("/a.md", 1), file("/b.md", 3), file("/c.md", 2)];

		expect(buildRecentFilesList(files).map((f) => f.path)).toEqual([
			"/b.md",
			"/c.md",
			"/a.md",
		]);
	});

	it("does not truncate when at or under the limit", () => {
		const files = Array.from({ length: RECENT_FILES_LIMIT }, (_, i) =>
			file(`/file-${i}.md`, i),
		);

		expect(buildRecentFilesList(files)).toHaveLength(RECENT_FILES_LIMIT);
	});

	it("caps to the limit, keeping the most recent and dropping the rest", () => {
		const files = Array.from({ length: RECENT_FILES_LIMIT + 1 }, (_, i) =>
			file(`/file-${i}.md`, i),
		);

		const result = buildRecentFilesList(files);

		expect(result).toHaveLength(RECENT_FILES_LIMIT);
		// file-0 has the oldest modifiedAt (0) and is the one that should fall off.
		expect(result.map((f) => f.path)).not.toContain("/file-0.md");
		expect(result.map((f) => f.path)).toContain(
			`/file-${RECENT_FILES_LIMIT}.md`,
		);
	});

	it("supports a custom limit", () => {
		const files = [file("/a.md", 3), file("/b.md", 2), file("/c.md", 1)];

		expect(buildRecentFilesList(files, 2).map((f) => f.path)).toEqual([
			"/a.md",
			"/b.md",
		]);
	});

	it("falls back to alphabetical-by-filename when modifiedAt is equal or undefined", () => {
		const files = [file("/z.md"), file("/a.md"), file("/m.md")];

		expect(buildRecentFilesList(files).map((f) => f.path)).toEqual([
			"/a.md",
			"/m.md",
			"/z.md",
		]);
	});

	it("does not mutate the input array", () => {
		const files = [file("/a.md", 1), file("/b.md", 2)];
		const copy = [...files];

		buildRecentFilesList(files);

		expect(files).toEqual(copy);
	});
});
