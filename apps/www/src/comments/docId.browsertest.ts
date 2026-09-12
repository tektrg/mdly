import type { PathIndexEntry } from "@mdly/doc-history";
import { afterEach, describe, expect, it } from "vitest";
import type { SidecarEntry } from "../store/sidecars";
import { resetDocIdCache, resolveDocIdForPath } from "./docId";

/** Builds a sidecars map from filename → index entries. */
function sidecars(
	shards: Record<string, PathIndexEntry[]>,
	versionBump = "",
): Record<string, SidecarEntry> {
	const map: Record<string, SidecarEntry> = {};
	for (const [name, entries] of Object.entries(shards)) {
		const key = `.mdly/history/${name}`;
		map[key] = {
			path: key,
			content:
				entries.map((e) => JSON.stringify(e)).join("\n") + "\n" + versionBump,
			contentHash: key,
			updatedAt: 1,
		};
	}
	return map;
}

const assign = (
	id: string,
	at: number,
	docId: string,
	path: string,
): PathIndexEntry => ({ id, at, event: "assign", docId, path });

afterEach(() => {
	resetDocIdCache();
});

describe("resolveDocIdForPath across merged index siblings", () => {
	it("resolves across index.jsonl plus index 2.jsonl", async () => {
		const map = sidecars({
			"index.jsonl": [assign("a1", 1, "doc-1", "note.md")],
			"index 2.jsonl": [assign("b1", 2, "doc-2", "other.md")],
		});
		await expect(resolveDocIdForPath("note.md", map, 1)).resolves.toBe("doc-1");
		await expect(resolveDocIdForPath("other.md", map, 1)).resolves.toBe("doc-2");
	});

	it("follows a rename to the current path", async () => {
		const map = sidecars({
			"index.jsonl": [assign("a1", 1, "doc-1", "note.md")],
			"index 2.jsonl": [
				{
					id: "b1",
					at: 2,
					event: "rename",
					docId: "doc-1",
					path: "renamed.md",
					fromPath: "note.md",
				},
			],
		});
		await expect(resolveDocIdForPath("renamed.md", map, 1)).resolves.toBe(
			"doc-1",
		);
		await expect(resolveDocIdForPath("note.md", map, 1)).resolves.toBeUndefined();
	});

	it("returns undefined for a path with no docId and never mints one", async () => {
		const map = sidecars({
			"index.jsonl": [assign("a1", 1, "doc-1", "note.md")],
		});
		await expect(resolveDocIdForPath("unindexed.md", map, 1)).resolves.toBeUndefined();
		expect(Object.keys(map)).toHaveLength(1);
	});

	it("re-resolves when commentsVersion moves", async () => {
		const v1 = sidecars({ "index.jsonl": [assign("a1", 1, "doc-1", "note.md")] });
		await expect(resolveDocIdForPath("note.md", v1, 1)).resolves.toBe("doc-1");
		const v2 = sidecars({
			"index.jsonl": [
				assign("a1", 1, "doc-1", "note.md"),
				assign("a2", 3, "doc-9", "fresh.md"),
			],
		});
		await expect(resolveDocIdForPath("fresh.md", v2, 2)).resolves.toBe("doc-9");
	});
});
