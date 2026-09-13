import { describe, expect, it } from "vitest";
import {
	buildTagTree,
	flattenTagTree,
	groupFilesByTag,
	tagGroupAncestors,
} from "./buildTagTree";
import type { SidebarFile } from "./useSidebarTree";

describe("buildTagTree", () => {
	it("nests separator tags under verbatim group nodes", () => {
		const root = buildTagTree(
			[
				{ name: "meeting/deep-sync", count: 2 },
				{ name: "meeting/e-commerce-weekly", count: 1 },
				{ name: "work", count: 3 },
			],
			"/",
		);

		const group = root.children.find(
			(child) => child.fullPath === "meeting",
		);
		expect(group?.segment).toBe("meeting");
		expect(group?.tagName).toBeNull();
		expect(group?.children.map((child) => child.fullPath)).toEqual([
			"meeting/deep-sync",
			"meeting/e-commerce-weekly",
		]);
		// Bare tags stay top-level leaves.
		expect(
			root.children.find((child) => child.fullPath === "work"),
		).toMatchObject({ tagName: "work", children: [] });
	});

	it("never humanizes segments -- labels are the host's job", () => {
		const root = buildTagTree(
			[{ name: "meeting/deep-sync", count: 1 }],
			"/",
		);

		expect(root.children[0]?.segment).toBe("meeting");
		expect(root.children[0]?.children[0]?.segment).toBe("deep-sync");
	});

	it("sorts siblings by count desc, then path asc -- mirroring the flat list", () => {
		const root = buildTagTree(
			[
				{ name: "b/b2", count: 1 },
				{ name: "a/a2", count: 1 },
				{ name: "big/x", count: 5 },
			],
			"/",
		);

		expect(root.children.map((child) => child.fullPath)).toEqual([
			"big",
			"a",
			"b",
		]);
	});

	it("treats a tag that is both a namespace and a tag as one row doing both", () => {
		const root = buildTagTree(
			[
				{ name: "meeting", count: 1 },
				{ name: "meeting/weekly", count: 2 },
			],
			"/",
		);

		const group = root.children.find(
			(child) => child.fullPath === "meeting",
		);
		expect(group?.tagName).toBe("meeting");
		expect(group?.ownCount).toBe(1);
		expect(group?.children).toHaveLength(1);
	});

	it("sums subtree counts when no files are supplied", () => {
		const root = buildTagTree(
			[
				{ name: "meeting/a", count: 2 },
				{ name: "meeting/b", count: 3 },
			],
			"/",
		);

		expect(
			root.children.find((child) => child.fullPath === "meeting")?.count,
		).toBe(5);
	});

	it("counts distinct files per group when files are supplied", () => {
		const files: SidebarFile[] = [
			{ path: "one.md", tags: ["meeting/a", "meeting/b"] },
			{ path: "two.md", tags: ["meeting/a"] },
		];
		const root = buildTagTree(
			[
				{ name: "meeting/a", count: 2 },
				{ name: "meeting/b", count: 1 },
			],
			"/",
			files,
		);

		// One file carries both series tags but counts once toward the namespace.
		expect(
			root.children.find((child) => child.fullPath === "meeting")?.count,
		).toBe(2);
	});

	it("reports leaf counts too when files are supplied (no all-zero sub-tags)", () => {
		const files: SidebarFile[] = [
			{ path: "one.md", tags: ["team/aptus", "type/meeting"] },
			{ path: "two.md", tags: ["team/aptus"] },
		];
		const root = buildTagTree(
			[
				{ name: "team/aptus", count: 2 },
				{ name: "type/meeting", count: 1 },
			],
			"/",
			files,
		);

		const leaves = new Map(
			[...root.children].flatMap((group) =>
				group.children.map((leaf) => [leaf.fullPath, leaf.count] as const),
			),
		);
		expect(leaves.get("team/aptus")).toBe(2);
		expect(leaves.get("type/meeting")).toBe(1);
	});

	it("keeps every tag a top-level leaf when the separator is empty", () => {
		const root = buildTagTree(
			[
				{ name: "meeting/deep-sync", count: 1 },
				{ name: "work", count: 2 },
			],
			"",
		);

		expect(root.children.map((child) => child.fullPath)).toEqual([
			"work",
			"meeting/deep-sync",
		]);
	});

	it("keeps degenerate tags as verbatim leaves", () => {
		const root = buildTagTree([{ name: "/", count: 1 }], "/");

		expect(root.children).toHaveLength(1);
		expect(root.children[0]).toMatchObject({
			tagName: "/",
			children: [],
		});
	});
});

describe("tagGroupAncestors", () => {
	it("returns group paths shallowest-first, none for bare tags", () => {
		expect(tagGroupAncestors("meeting/deep-sync", "/")).toEqual(["meeting"]);
		expect(tagGroupAncestors("a/b/c", "/")).toEqual(["a", "a/b"]);
		expect(tagGroupAncestors("work", "/")).toEqual([]);
		expect(tagGroupAncestors("a/b", "")).toEqual([]);
	});
});

describe("groupFilesByTag", () => {
	it("lists each file once per tag even when the file repeats it", () => {
		const file: SidebarFile = { path: "a.md", tags: ["x", "x", "y"] };

		expect(groupFilesByTag([file]).get("x")).toEqual([file]);
		expect(groupFilesByTag([file]).get("y")).toEqual([file]);
	});

	it("ignores untagged files", () => {
		expect(groupFilesByTag([{ path: "a.md" }]).size).toBe(0);
	});
});

describe("flattenTagTree", () => {
	const tags = [
		{ name: "meeting/deep-sync", count: 2 },
		{ name: "work", count: 1 },
	];
	const files: SidebarFile[] = [
		{ path: "standup.md", tags: ["meeting/deep-sync"] },
		{ path: "standup-recording.m4a", tags: ["meeting/deep-sync"] },
	];
	const filesByTag = groupFilesByTag(files);

	it("emits only top-level rows when nothing is expanded", () => {
		const rows = flattenTagTree(
			buildTagTree(tags, "/", files),
			new Set(),
			filesByTag,
		);

		expect(
			rows.map((row) =>
				row.kind === "group"
					? `group:${row.fullPath}`
					: row.kind === "tag"
						? `tag:${row.tag.name}`
						: `file:${row.file.path}`,
			),
		).toEqual(["group:meeting", "tag:work"]);
	});

	it("reveals series under an expanded namespace and files under an expanded leaf", () => {		const rows = flattenTagTree(
			buildTagTree(tags, "/", files),
			new Set(["meeting", "meeting/deep-sync"]),
			filesByTag,
		);

		expect(
			rows.map((row) =>
				row.kind === "group"
					? `group:${row.fullPath}:${row.expanded}`
					: row.kind === "tag"
						? `tag:${row.tag.name}:${row.expanded}`
						: `file:${row.file.path}@${row.depth}`,
			),
		).toEqual([
			"group:meeting:true",
			"tag:meeting/deep-sync:true",
			"file:standup.md@2",
			"file:standup-recording.m4a@2",
			"tag:work:false",
		]);
	});

	it("carries non-zero leaf counts and verbatim segments on tag rows", () => {
		const rows = flattenTagTree(
			buildTagTree(tags, "/", files),
			new Set(["meeting"]),
			filesByTag,
		);

		const leaf = rows.find(
			(row): row is Extract<typeof row, { kind: "tag" }> =>
				row.kind === "tag" && row.tag.name === "meeting/deep-sync",
		);
		expect(leaf?.tag.count).toBe(2);
		expect(leaf?.segment).toBe("deep-sync");
	});
});
