/**
 * Saved-view groupings that are not a property (FastTab's grouping rule):
 * Folder (full folder path), Top-level folder (first segment) and Tag (a
 * multi-tag document appears in each of its tags' groups).
 *
 * Groups are ordered biggest first, then A→Z; "Other" (no value: a root file,
 * an untagged one) is always last; empty groups never appear. The result is a
 * flat `NavGroupNode` root, so the nav list's headers, collapse state and
 * virtualized flattening render it unchanged.
 */
import type { NavDocument, NavGroupNode } from "../navGroupTree";
import type { PathGroupBy } from "./documentViews";

export const OTHER_GROUP_LABEL = "Other";

function keysOf(doc: NavDocument, groupBy: PathGroupBy): string[] {
	if (groupBy === "group:tag") {
		const keys = new Set<string>();
		for (const tag of doc.tags ?? []) {
			const trimmed = tag.trim();
			if (trimmed) keys.add(trimmed);
		}
		return [...keys];
	}
	const folder = doc.folderPath.trim();
	if (!folder) return [];
	return [groupBy === "group:topFolder" ? folder.split("/")[0] : folder];
}

function node(id: string, label: string, isFallback: boolean): NavGroupNode {
	return {
		id,
		segment: label,
		label,
		depth: 0,
		members: new Set(),
		ownPaths: [],
		children: [],
		droppable: false,
		collapsedByDefault: false,
		isFallback,
	};
}

/** Rows (already filtered and sorted) grouped by folder / top folder / tag. */
export function buildPathGroupTree(
	docs: readonly NavDocument[],
	groupBy: PathGroupBy,
): NavGroupNode {
	const root = node("", "", false);
	root.depth = -1;
	const groups = new Map<string, NavGroupNode>();
	let other: NavGroupNode | null = null;
	for (const doc of docs) {
		root.members.add(doc.path);
		const keys = keysOf(doc, groupBy);
		if (keys.length === 0) {
			other ??= node(`${groupBy}::(other)`, OTHER_GROUP_LABEL, true);
			other.members.add(doc.path);
			other.ownPaths.push(doc.path);
			continue;
		}
		for (const key of keys) {
			let group = groups.get(key);
			if (!group) {
				group = node(`${groupBy}::${key}`, key, false);
				groups.set(key, group);
			}
			group.members.add(doc.path);
			group.ownPaths.push(doc.path);
		}
	}
	root.children = [...groups.values()].sort(
		(a, b) =>
			b.members.size - a.members.size ||
			a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) ||
			(a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
	);
	if (other) root.children.push(other);
	return root;
}
