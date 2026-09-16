import { describe, expect, it } from "vitest";
import {
	buildGroupTree,
	buildNavRows,
	defaultExpandedIds,
	flattenGroupRows,
	type NavDocument,
	type NavGroupNode,
	type NavView,
	PINNED_GROUP_ID,
	resolveNavViewSpec,
	UNTAGGED_GROUP_ID,
} from "./navGroupTree";

function doc(path: string, extra: Partial<NavDocument> = {}): NavDocument {
	const lastSlash = path.lastIndexOf("/");
	return {
		path,
		folderPath: lastSlash === -1 ? "" : path.slice(0, lastSlash),
		...extra,
	};
}

function view(overrides: Partial<NavView> = {}): NavView {
	return { groupBy: null, mode: "browse", filter: "", ...overrides };
}

function nodeAt(root: NavGroupNode, id: string): NavGroupNode | undefined {
	if (root.id === id) return root;
	for (const child of root.children) {
		const hit = nodeAt(child, id);
		if (hit) return hit;
	}
	return undefined;
}

function allIds(root: NavGroupNode): Set<string> {
	const ids = new Set<string>();
	const walk = (node: NavGroupNode) => {
		for (const child of node.children) {
			ids.add(child.id);
			walk(child);
		}
	};
	walk(root);
	return ids;
}

describe("resolveNavViewSpec (A7, R2, EC-93)", () => {
	it("suspends the Pinned section and grouping while a query is live", () => {
		const spec = resolveNavViewSpec(
			view({ groupBy: "folder", mode: "search", filter: "budget" }),
		);

		expect(spec.groupBy).toBeNull();
		expect(spec.pinnedSection).toBe(false);
		expect(spec.ranked).toBe(true);
	});

	it("restores pinning and grouping the moment the query clears", () => {
		const searching = view({
			groupBy: "folder",
			mode: "search",
			filter: "budget",
		});
		const cleared = { ...searching, filter: "" };

		expect(resolveNavViewSpec(searching).pinnedSection).toBe(false);
		// Same mode, empty query: no second flag to flip, so restoration cannot
		// lag the keystroke that cleared it (EC-92).
		expect(resolveNavViewSpec(cleared).pinnedSection).toBe(true);
		expect(resolveNavViewSpec(cleared).groupBy).toBe("folder");
		expect(resolveNavViewSpec(cleared).ranked).toBe(false);
	});

	it("treats a whitespace-only query as no query", () => {
		expect(
			resolveNavViewSpec(view({ mode: "search", filter: "   " })).ranked,
		).toBe(false);
	});

	it("declares folder view's empty-key behaviour as root rows", () => {
		const spec = resolveNavViewSpec(view({ groupBy: "folder" }));

		expect(spec.emptyKeyBehavior).toEqual({ kind: "root-rows" });
		expect(spec.rootDropTarget).toBe(true);
		expect(spec.keysForRow(doc("notes/a.md"))).toEqual(["notes"]);
		expect(spec.keysForRow(doc("a.md"))).toEqual([]);
	});

	it("declares tag view's fallback group as a field, not a special case (A5)", () => {
		const spec = resolveNavViewSpec(view({ groupBy: "tag" }));

		expect(spec.emptyKeyBehavior).toEqual({
			kind: "fallback-group",
			group: {
				id: UNTAGGED_GROUP_ID,
				label: "Untagged",
				position: "last",
				collapsedByDefault: true,
				droppable: false,
			},
		});
		// A tag group cannot mean "the workspace root".
		expect(spec.rootDropTarget).toBe(false);
	});

	it("returns one key per tag -- R4's one-to-many falls out of the signature", () => {
		const spec = resolveNavViewSpec(view({ groupBy: "tag" }));

		expect(
			spec.keysForRow(doc("a.md", { tags: ["x/1", "x/2", "y", "x/1", " "] })),
		).toEqual(["x/1", "x/2", "y"]);
	});
});

describe("buildGroupTree (R3, R4, EC-03/04/05/44)", () => {
	it("gives every folder segment its own node -- a/b/c is three, not one (EC-03)", () => {
		const spec = resolveNavViewSpec(view({ groupBy: "folder" }));
		const tree = buildGroupTree([doc("a/b/c/note.md")], spec);

		expect(tree.children.map((child) => child.id)).toEqual(["a"]);
		expect(nodeAt(tree, "a")?.children.map((child) => child.id)).toEqual([
			"a/b",
		]);
		expect(nodeAt(tree, "a/b")?.children.map((child) => child.id)).toEqual([
			"a/b/c",
		]);
		expect(nodeAt(tree, "a/b/c")?.ownPaths).toEqual(["a/b/c/note.md"]);
		expect(allIds(tree)).toEqual(new Set(["a", "a/b", "a/b/c"]));
	});

	it("files a document under every tag it carries, and counts it ONCE per node (EC-04/EC-05)", () => {
		// Fixture ported from packages/workspace-kit/src/nav/buildTagTree.test.ts,
		// so the distinct-count claim is asserted against proven behaviour.
		const spec = resolveNavViewSpec(view({ groupBy: "tag" }));
		const tree = buildGroupTree(
			[doc("one.md", { tags: ["x/1", "x/2", "y"] })],
			spec,
		);

		expect(nodeAt(tree, "x/1")?.members.size).toBe(1);
		expect(nodeAt(tree, "x/2")?.members.size).toBe(1);
		expect(nodeAt(tree, "y")?.members.size).toBe(1);
		// The document appears under three leaves...
		expect(
			[nodeAt(tree, "x/1"), nodeAt(tree, "x/2"), nodeAt(tree, "y")].map(
				(node) => node?.ownPaths,
			),
		).toEqual([["one.md"], ["one.md"], ["one.md"]]);
		// ...but node `x` counts 1, not 2. A sum of children would say 2.
		expect(nodeAt(tree, "x")?.members.size).toBe(1);
	});

	it("counts distinct documents, never rows, across a shared namespace", () => {
		const spec = resolveNavViewSpec(view({ groupBy: "tag" }));
		const tree = buildGroupTree(
			[
				doc("one.md", { tags: ["meeting/a", "meeting/b"] }),
				doc("two.md", { tags: ["meeting/a"] }),
			],
			spec,
		);

		expect(nodeAt(tree, "meeting")?.members.size).toBe(2);
		expect(nodeAt(tree, "meeting/a")?.members.size).toBe(2);
		expect(nodeAt(tree, "meeting/b")?.members.size).toBe(1);
	});

	it("drops empty and whitespace-only segments instead of making phantom nodes (EC-44)", () => {
		const spec = resolveNavViewSpec(view({ groupBy: "tag" }));
		const tree = buildGroupTree(
			[doc("one.md", { tags: ["a//b", " a / b ", "/"] })],
			spec,
		);

		expect(allIds(tree)).toEqual(new Set(["a", "a/b"]));
		expect(nodeAt(tree, "a/b")?.members.size).toBe(1);
	});

	it("keeps root documents as root rows in folder view", () => {
		const spec = resolveNavViewSpec(view({ groupBy: "folder" }));
		const tree = buildGroupTree([doc("loose.md"), doc("notes/a.md")], spec);

		expect(tree.ownPaths).toEqual(["loose.md"]);
		expect(tree.children.map((child) => child.id)).toEqual(["notes"]);
	});
});

describe("the Untagged bucket (A5, EC-60/EC-73)", () => {
	const spec = resolveNavViewSpec(view({ groupBy: "tag" }));

	it("collects untagged documents, emits last, collapsed, never droppable", () => {
		const tree = buildGroupTree(
			[doc("plain.md"), doc("zed.md", { tags: ["zeta"] })],
			spec,
		);
		const untagged = nodeAt(tree, UNTAGGED_GROUP_ID);

		expect(untagged?.label).toBe("Untagged");
		expect(untagged?.droppable).toBe(false);
		expect(untagged?.collapsedByDefault).toBe(true);
		expect(untagged?.members.size).toBe(1);
		// Last even though "Untagged" sorts before "zeta" alphabetically.
		expect(tree.children[tree.children.length - 1]?.id).toBe(UNTAGGED_GROUP_ID);

		const rows = flattenGroupRows(tree, new Set(), [], spec);
		expect(rows[rows.length - 1]).toMatchObject({
			kind: "group",
			id: UNTAGGED_GROUP_ID,
			droppable: false,
		});
	});

	it("disappears entirely when every document carries a tag (EC-60)", () => {
		const tree = buildGroupTree([doc("a.md", { tags: ["x"] })], spec);

		expect(nodeAt(tree, UNTAGGED_GROUP_ID)).toBeUndefined();
	});

	it("is excluded from the default expansion while real groups are included", () => {
		const tree = buildGroupTree(
			[doc("plain.md"), doc("a.md", { tags: ["x/1"] })],
			spec,
		);

		expect(defaultExpandedIds(tree)).toEqual(new Set(["x", "x/1"]));
	});
});

describe("flattenGroupRows (R10, EC-13/EC-73)", () => {
	const spec = resolveNavViewSpec(view({ groupBy: "folder" }));

	it("emits children only under expanded nodes", () => {
		const docs = [doc("a/b/note.md"), doc("loose.md")];
		const tree = buildGroupTree(docs, spec);

		expect(
			flattenGroupRows(tree, new Set(), docs, spec).map((row) => row.id),
		).toEqual(["a", "::loose.md"]);
		expect(
			flattenGroupRows(tree, new Set(["a"]), docs, spec).map((row) => row.id),
		).toEqual(["a", "a/b", "::loose.md"]);
		expect(
			flattenGroupRows(tree, new Set(["a", "a/b"]), docs, spec).map(
				(row) => row.id,
			),
		).toEqual(["a", "a/b", "a/b::a/b/note.md", "::loose.md"]);
	});

	it("keys a document row by group so one document under two groups is two rows", () => {
		const tagSpec = resolveNavViewSpec(view({ groupBy: "tag" }));
		const docs = [doc("one.md", { tags: ["x", "y"] })];
		const tree = buildGroupTree(docs, tagSpec);

		expect(
			flattenGroupRows(tree, new Set(["x", "y"]), docs, tagSpec)
				.filter((row) => row.kind === "document")
				.map((row) => row.id),
		).toEqual(["x::one.md", "y::one.md"]);
	});

	it("puts the Pinned section first and repeats the pinned document in its group", () => {
		const docs = [doc("a/keep.md", { isUserPinned: true }), doc("a/other.md")];
		const tree = buildGroupTree(docs, spec);
		const rows = flattenGroupRows(
			tree,
			new Set([PINNED_GROUP_ID, "a"]),
			docs,
			spec,
		);

		expect(rows.map((row) => row.id)).toEqual([
			PINNED_GROUP_ID,
			`${PINNED_GROUP_ID}::a/keep.md`,
			"a",
			"a::a/keep.md",
			"a::a/other.md",
		]);
		// The group header still counts both documents, including the pinned one
		// (EC-73: a group whose only member is pinned is never pruned away).
		expect(rows.find((row) => row.id === "a")).toMatchObject({ count: 2 });
	});

	it("omits the Pinned section entirely when the spec suspends it (A7/EC-82)", () => {
		const searchSpec = resolveNavViewSpec(
			view({ groupBy: "folder", mode: "search", filter: "keep" }),
		);
		const docs = [doc("a/keep.md", { isUserPinned: true })];
		const tree = buildGroupTree(docs, searchSpec);
		const rows = flattenGroupRows(
			tree,
			new Set([PINNED_GROUP_ID, "a"]),
			docs,
			searchSpec,
		);

		// Ranked results only, in the caller's order, with no group headers.
		expect(rows.map((row) => row.id)).toEqual(["::a/keep.md"]);
	});

	it("emits documents in the sorted order it was given, not the tree's insertion order", () => {
		const unsorted = [doc("a/z.md"), doc("a/m.md")];
		const tree = buildGroupTree(unsorted, spec);
		const sorted = [doc("a/m.md"), doc("a/z.md")];

		expect(
			flattenGroupRows(tree, new Set(["a"]), sorted, spec)
				.filter((row) => row.kind === "document")
				.map((row) => row.doc.path),
		).toEqual(["a/m.md", "a/z.md"]);
	});
});

describe("buildNavRows (the seam)", () => {
	it("composes spec, tree and rows in one call", () => {
		const docs = [doc("a/b/note.md")];
		const result = buildNavRows({
			docs,
			view: view({ groupBy: "folder" }),
			expandedIds: new Set(["a", "a/b"]),
		});

		expect(result.state).toBe("ready");
		expect(result.spec.groupBy).toBe("folder");
		expect(result.rows.map((row) => row.id)).toEqual([
			"a",
			"a/b",
			"a/b::a/b/note.md",
		]);
	});

	it("reports tags-pending and emits no rows rather than grouping a missing map (EC-39)", () => {
		const result = buildNavRows({
			docs: [doc("a.md"), doc("b.md", { tags: ["x"] })],
			view: view({ groupBy: "tag" }),
			expandedIds: new Set(),
			tagsReady: false,
		});

		expect(result.state).toBe("tags-pending");
		expect(result.rows).toEqual([]);
		// Specifically: not one collapsed Untagged holding the whole workspace.
		expect(result.tree.children).toEqual([]);
	});

	it("never reads the query for grouping -- only the spec does (EC-93)", () => {
		const docs = [doc("a/one.md")];
		const grouped = buildNavRows({
			docs,
			view: view({ groupBy: "folder", filter: "nomatch" }),
			expandedIds: new Set(["a"]),
		});

		// `mode` is "browse", so the filter text changes nothing about grouping;
		// filtering happened before the engine was called.
		expect(grouped.rows.map((row) => row.id)).toEqual(["a", "a::a/one.md"]);
	});
});
