import type { SidebarTag } from "./buildTagCounts";
import type { SidebarFile } from "./useSidebarTree";

export type TagTreeNode = {
	/** Full tag path from the root, e.g. `"meeting/deep-sync"`. Empty on the root. */
	fullPath: string;
	/** Raw path segment, verbatim — never humanized (see below). */
	segment: string;
	/** Depth below the root; root itself is -1, its children 0. */
	depth: number;
	/** Exact tag name terminating at this node, when one does. */
	tagName: string | null;
	/** File count for the exact tag at this node, 0 when none terminates here. */
	ownCount: number;
	/**
	 * Aggregate count for the subtree: the number of distinct files carrying
	 * any tag at or below this node when `files` was supplied, else the sum of
	 * the subtree's `ownCount`s. Leaves always report `ownCount`. Used for
	 * sibling ordering only — the tree renders no counts, like the folder tree.
	 */
	count: number;
	/** Children sorted by count descending, then path ascending (mirrors the flat list). */
	children: TagTreeNode[];
};

export type FlatTagTreeRow =
	| {
			kind: "group";
			id: string;
			fullPath: string;
			segment: string;
			depth: number;
			expanded: boolean;
			count: number;
			/** Exact tag terminating here too, when a tag is both a namespace and a tag. */
			tagName: string | null;
	  }
	| {
			kind: "tag";
			tag: SidebarTag;
			/** Verbatim last segment — the tree's default leaf label. */
			segment: string;
			depth: number;
			expanded: boolean;
	  }
	| {
			kind: "file";
			file: SidebarFile;
			parentTag: string;
			depth: number;
	  };

/**
 * Nests flat `{ name, count }` tag rows into a tree on a separator.
 *
 * Semantics-free like `buildTagCounts`: it splits names on the separator and
 * nothing else. It never humanizes segments (`meeting` stays `meeting` —
 * labels like "Meetings" come from the host via render-props), never colors,
 * and never parses files. Hosts populate `SidebarFile.tags`; the optional
 * `files` argument is only used to de-duplicate group counts and to be able
 * to list files inline — never to derive new tags.
 *
 * Tags without the separator (or a falsy separator) stay top-level leaves,
 * so a host that passes no separator gets the exact flat list back as a tree
 * with no groups. Segments that are empty after splitting are dropped; a tag
 * that reduces to a single segment (e.g. `"/"` itself) stays a verbatim leaf.
 *
 * Pure over its inputs and testable without a DOM, mirroring
 * `buildRecentFilesList`.
 */
export function buildTagTree(
	tags: readonly SidebarTag[],
	separator: string,
	files: readonly SidebarFile[] = [],
): TagTreeNode {
	const root: TagTreeNode = {
		fullPath: "",
		segment: "",
		depth: -1,
		tagName: null,
		ownCount: 0,
		count: 0,
		children: [],
	};
	const byPath = new Map<string, TagTreeNode>([["", root]]);

	const ensureNode = (parent: TagTreeNode, segment: string): TagTreeNode => {
		const fullPath = parent.fullPath
			? `${parent.fullPath}${separator}${segment}`
			: segment;
		let node = byPath.get(fullPath);
		if (!node) {
			node = {
				fullPath,
				segment,
				depth: parent.depth + 1,
				tagName: null,
				ownCount: 0,
				count: 0,
				children: [],
			};
			byPath.set(fullPath, node);
			parent.children.push(node);
		}
		return node;
	};

	for (const tag of tags) {
		const segments = separator
			? tag.name.split(separator).filter((part) => part.length > 0)
			: [tag.name];
		if (segments.length <= 1) {
			// A bare tag may share its path with a group another tag created
			// (e.g. both `meeting` and `meeting/weekly` exist) — merge into
			// that node rather than adding a second row for the same path.
			const existing = byPath.get(tag.name);
			if (existing && existing !== root) {
				existing.tagName = tag.name;
				existing.ownCount = tag.count;
				continue;
			}
			const leaf: TagTreeNode = {
				fullPath: tag.name,
				segment: tag.name,
				depth: 0,
				tagName: tag.name,
				ownCount: tag.count,
				count: tag.count,
				children: [],
			};
			byPath.set(tag.name, leaf);
			root.children.push(leaf);
			continue;
		}
		let parent = root;
		for (const segment of segments) {
			parent = ensureNode(parent, segment);
		}
		// A tag may terminate at a node that also has children (e.g. both
		// `meeting` and `meeting/weekly` exist) — the row then both selects
		// the exact tag and expands to the children.
		parent.tagName = tag.name;
		parent.ownCount = tag.count;
	}

	if (separator && files.length > 0) {
		// Distinct-file counts: one file carrying two tags in the same
		// namespace still counts once toward that namespace.
		const memberFiles = new Map<string, Set<string>>();
		const addMember = (path: string, filePath: string) => {
			let members = memberFiles.get(path);
			if (!members) {
				members = new Set<string>();
				memberFiles.set(path, members);
			}
			members.add(filePath);
		};
		for (const file of files) {
			if (!file.tags) continue;
			const seen = new Set<string>();
			for (const name of file.tags) {
				if (seen.has(name)) continue;
				seen.add(name);
				addMember(name, file.path);
				for (const ancestor of tagGroupAncestors(name, separator)) {
					addMember(ancestor, file.path);
				}
			}
		}
		for (const node of byPath.values()) {
			if (node === root) continue;
			// Leaves carry their exact tag's files too — skipping childless
			// nodes here left every leaf at its initial 0 (the all-zero
			// sub-tag counts). Groups de-duplicate across their namespace;
			// leaves just report their own tag.
			node.count =
				memberFiles.get(node.fullPath)?.size ??
				(node.children.length === 0
					? node.ownCount
					: sumOwnCounts(node));
		}
	} else {
		for (const child of root.children) {
			sumCounts(child);
		}
	}
	root.count = root.children.reduce((total, child) => total + child.count, 0);
	sortTree(root);
	return root;
}

/**
 * Group full-paths above a tag, shallowest first: `"a/b/c"` → `["a", "a/b"]`.
 * Bare tags (or a falsy separator) have no ancestors. Used to auto-expand the
 * path to the active tag, mirroring the folder tree revealing its highlight.
 */
export function tagGroupAncestors(
	tagName: string,
	separator: string,
): string[] {
	if (!separator) return [];
	const segments = tagName.split(separator).filter((part) => part.length > 0);
	if (segments.length <= 1) return [];
	const ancestors: string[] = [];
	let path = "";
	for (let index = 0; index < segments.length - 1; index++) {
		path = path ? `${path}${separator}${segments[index]}` : segments[index]!;
		ancestors.push(path);
	}
	return ancestors;
}

/**
 * Maps each tag name to the files carrying it, each file listed at most once
 * per tag. Preserves input order; sorting for display is the caller's job
 * (it needs the host's display-path function, which this module never sees).
 */
export function groupFilesByTag(
	files: readonly SidebarFile[],
): Map<string, SidebarFile[]> {
	const grouped = new Map<string, SidebarFile[]>();
	for (const file of files) {
		if (!file.tags) continue;
		const seen = new Set<string>();
		for (const name of file.tags) {
			if (seen.has(name)) continue;
			seen.add(name);
			let list = grouped.get(name);
			if (!list) {
				list = [];
				grouped.set(name, list);
			}
			list.push(file);
		}
	}
	return grouped;
}

/**
 * Flattens a tag tree into keyboard-navigable/virtualizable rows, emitting
 * children (and a tag's inline files) only under expanded nodes — the same
 * shape `useSidebarTree`'s `flattenRows` produces for the Documents page.
 */
export function flattenTagTree(
	root: TagTreeNode,
	expanded: ReadonlySet<string>,
	filesByTag: ReadonlyMap<string, readonly SidebarFile[]>,
): FlatTagTreeRow[] {
	const rows: FlatTagTreeRow[] = [];
	const pushFileRows = (parentTag: string, depth: number) => {
		for (const file of filesByTag.get(parentTag) ?? []) {
			rows.push({ kind: "file", file, parentTag, depth });
		}
	};
	const walk = (node: TagTreeNode) => {
		for (const child of node.children) {
			if (child.children.length > 0) {
				const isOpen = expanded.has(child.fullPath);
				rows.push({
					kind: "group",
					id: child.fullPath,
					fullPath: child.fullPath,
					segment: child.segment,
					depth: child.depth,
					expanded: isOpen,
					count: child.count,
					tagName: child.tagName,
				});
				if (!isOpen) continue;
				walk(child);
				if (child.tagName) pushFileRows(child.tagName, child.depth + 1);
			} else if (child.tagName) {
				const isOpen = expanded.has(child.tagName);
				rows.push({
					kind: "tag",
					tag: { name: child.tagName, count: child.count },
					segment: child.segment,
					depth: child.depth,
					expanded: isOpen,
				});
				if (isOpen) pushFileRows(child.tagName, child.depth + 1);
			}
		}
	};
	walk(root);
	return rows;
}

function sumOwnCounts(node: TagTreeNode): number {
	return (
		node.ownCount +
		node.children.reduce((total, child) => total + sumOwnCounts(child), 0)
	);
}

function sumCounts(node: TagTreeNode): number {
	node.count =
		node.children.length === 0
			? node.ownCount
			: node.children.reduce((total, child) => total + sumCounts(child), 0);
	return node.count;
}

function sortTree(node: TagTreeNode): void {
	node.children.sort(
		(a, b) => b.count - a.count || a.fullPath.localeCompare(b.fullPath),
	);
	for (const child of node.children) sortTree(child);
}
