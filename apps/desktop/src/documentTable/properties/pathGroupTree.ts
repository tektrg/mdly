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
import { basename } from "../../lib/filePath";
import { type LinkIndex, pathKey } from "../../lib/linkIndex";
import type { NavDocument, NavGroupNode } from "../navGroupTree";
import { PATH_GROUP_BY, type PathGroupBy } from "./documentViews";

const LINKED_FROM_PREFIX = `${PATH_GROUP_BY.linkedFrom}::`;

/** The linking document a "Linked from" group id stands for, else null. */
export function linkedFromGroupSource(groupId: string): string | null {
	return groupId.startsWith(LINKED_FROM_PREFIX) &&
		groupId !== `${LINKED_FROM_PREFIX}(other)`
		? groupId.slice(LINKED_FROM_PREFIX.length)
		: null;
}

function docName(path: string): string {
	return basename(path).replace(/\.(md|markdown)$/i, "");
}

/**
 * "Linked from" keys: the source paths linking to `doc`, self-links dropped.
 * One `incoming` lookup per row, so a whole grouping is O(rows + links).
 */
function linkerKeys(doc: NavDocument, index: LinkIndex | undefined): string[] {
	if (!index) return [];
	const key = pathKey(doc.path);
	const sources = index.incoming.get(key);
	if (!sources) return [];
	const keys: string[] = [];
	for (const sourceKey of sources) {
		if (sourceKey === key) continue;
		const entry = index.sources.get(sourceKey);
		if (entry) keys.push(entry.path);
	}
	return keys;
}

export const OTHER_GROUP_LABEL = "Other";

// One collator: `localeCompare` with options builds one per call, which
// dominates sorting thousands of "Linked from" groups.
const LABEL_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base" });

function keysOf(
	doc: NavDocument,
	groupBy: PathGroupBy,
	index: LinkIndex | undefined,
): string[] {
	if (groupBy === PATH_GROUP_BY.linkedFrom) return linkerKeys(doc, index);
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

/**
 * Rows (already filtered and sorted) grouped by folder / top folder / tag /
 * linking document. "Linked from" needs `linkIndex`; its group is titled by
 * the linker's name even when the view's filter excludes the linker itself.
 */
export function buildPathGroupTree(
	docs: readonly NavDocument[],
	groupBy: PathGroupBy,
	linkIndex?: LinkIndex,
): NavGroupNode {
	const root = node("", "", false);
	root.depth = -1;
	const groups = new Map<string, NavGroupNode>();
	let other: NavGroupNode | null = null;
	for (const doc of docs) {
		root.members.add(doc.path);
		const keys = keysOf(doc, groupBy, linkIndex);
		if (keys.length === 0) {
			other ??= node(`${groupBy}::(other)`, OTHER_GROUP_LABEL, true);
			other.members.add(doc.path);
			other.ownPaths.push(doc.path);
			continue;
		}
		for (const key of keys) {
			let group = groups.get(key);
			if (!group) {
				const label = groupBy === PATH_GROUP_BY.linkedFrom ? docName(key) : key;
				group = node(`${groupBy}::${key}`, label, false);
				groups.set(key, group);
			}
			group.members.add(doc.path);
			group.ownPaths.push(doc.path);
		}
	}
	root.children = [...groups.values()].sort(
		(a, b) =>
			b.members.size - a.members.size ||
			LABEL_COLLATOR.compare(a.label, b.label) ||
			(a.label < b.label ? -1 : a.label > b.label ? 1 : 0) ||
			(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
	if (other) root.children.push(other);
	return root;
}
