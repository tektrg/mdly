import { describe, expect, it } from "vitest";
import { buildFileTree } from "./useSidebarTree";

function folderNames(node: ReturnType<typeof buildFileTree>) {
	return [...node.folders.values()].map((folder) => folder.name);
}

describe("buildFileTree", () => {
	it("includes empty folders from directory entries", () => {
		const tree = buildFileTree(
			[],
			[{ path: "/workspace/empty", modifiedAt: 3 }],
			(path) => path.replace("/workspace/", ""),
		);

		expect(folderNames(tree)).toEqual(["empty"]);
		expect(tree.folders.get("empty")?.files).toEqual([]);
	});

	it("includes folder-only nested hierarchies from directory entries", () => {
		const tree = buildFileTree(
			[],
			[
				{ path: "/workspace/parent", modifiedAt: 1 },
				{ path: "/workspace/parent/child", modifiedAt: 2 },
			],
			(path) => path.replace("/workspace/", ""),
		);

		const parent = tree.folders.get("parent");
		expect(parent?.folders.get("child")?.files).toEqual([]);
	});

	it("does not render asset folders when listing omits them", () => {
		const tree = buildFileTree(
			[{ path: "/workspace/note.md", modifiedAt: 1 }],
			[],
			(path) => path.replace("/workspace/", ""),
		);

		expect(folderNames(tree)).toEqual([]);
	});

	it("preserves symlink metadata on files and folders", () => {
		const tree = buildFileTree(
			[
				{
					path: "/workspace/linked.md",
					modifiedAt: 1,
					isSymlink: true,
					symlinkTarget: "/target.md",
					symlinkTargetExists: true,
				},
			],
			[
				{
					path: "/workspace/linked-folder",
					modifiedAt: 2,
					isSymlink: true,
					symlinkTarget: "/target",
					symlinkTargetExists: false,
				},
			],
			(path) => path.replace("/workspace/", ""),
		);

		expect(tree.files[0]).toMatchObject({
			isSymlink: true,
			symlinkTarget: "/target.md",
			symlinkTargetExists: true,
		});
		expect(tree.folders.get("linked-folder")?.source).toMatchObject({
			isSymlink: true,
			symlinkTarget: "/target",
			symlinkTargetExists: false,
		});
	});
});
