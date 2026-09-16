/**
 * The one group-by engine behind every navigation view (R2).
 *
 * Folder view and tag view are not two components: they are two SPECS handed to
 * the same three passes. `resolveNavViewSpec` is the only place a mode branch
 * is taken — `buildGroupTree` and `flattenGroupRows` never read the query, the
 * mode or the view at all (A7, EC-93), which is what makes the Pinned
 * suspension a single fact rather than a condition repeated in every builder.
 *
 * Pure and DOM-free throughout.
 */

/** The separator the tag hierarchy nests on (R2). Folder paths use the same. */
export const NAV_PATH_SEPARATOR = "/";

/** The tag view's bucket for documents carrying no tags (A5). */
export const UNTAGGED_GROUP_ID = "__untagged__";

/** The Pinned section's synthetic group id (R6/EC-13). */
export const PINNED_GROUP_ID = "__pinned__";

/**
 * The minimum a row must carry to be grouped. Deliberately narrower than
 * `DocumentTableRow`: the engine groups on identity, a folder path and tags,
 * and must not grow a dependency on display fields.
 */
export type NavDocument = {
	/** Workspace entry path — the row's identity. */
	path: string;
	/** Workspace-RELATIVE parent folder; empty string at the workspace root. */
	folderPath: string;
	/** Front-matter tags, absent or empty when the document carries none. */
	tags?: readonly string[];
	/**
	 * The user's own pin (the Pinned section). Named apart from
	 * `isPinnedOffFilter`, which is the open document surviving a filter — two
	 * unrelated things that were both called "pinned" (defect 30).
	 */
	isUserPinned?: boolean;
};

export type NavGroupBy = "folder" | "tag" | null;
export type NavViewMode = "browse" | "search";

/** The view fields the engine reads. `filter` is the live query text. */
export type NavView = {
	groupBy: NavGroupBy;
	mode: NavViewMode;
	filter: string;
};

export type NavFallbackGroup = {
	id: string;
	label: string;
	position: "last";
	collapsedByDefault: boolean;
	droppable: boolean;
};

/**
 * What to do with a row whose `keysForRow` returns nothing. A DECLARED FIELD,
 * so no pass anywhere needs an `if (view === "tag")` special case (A5).
 */
export type NavEmptyKeyBehavior =
	| { kind: "root-rows" }
	| { kind: "fallback-group"; group: NavFallbackGroup };

export type NavViewSpec = {
	/** Also the drop-dispatch discriminator carried on every group row. */
	groupBy: NavGroupBy;
	/** Whether the Pinned section is emitted — false while a query is live (A7). */
	pinnedSection: boolean;
	/** Whether results are ordered by relevance rather than the view's sort. */
	ranked: boolean;
	emptyKeyBehavior: NavEmptyKeyBehavior;
	/** Whether the list container accepts a drop meaning "the workspace root". */
	rootDropTarget: boolean;
	separator: string;
	/** R4's one-to-many, in the signature: folder returns 0..1, tag returns 0..n. */
	keysForRow: (doc: NavDocument) => string[];
};

function distinctTagKeys(doc: NavDocument): string[] {
	const keys: string[] = [];
	const seen = new Set<string>();
	for (const tag of doc.tags ?? []) {
		const trimmed = tag.trim();
		if (trimmed.length === 0 || seen.has(trimmed)) continue;
		seen.add(trimmed);
		keys.push(trimmed);
	}
	return keys;
}

function folderKeys(doc: NavDocument): string[] {
	const trimmed = doc.folderPath.trim();
	return trimmed.length === 0 ? [] : [trimmed];
}

const UNTAGGED_FALLBACK: NavFallbackGroup = {
	id: UNTAGGED_GROUP_ID,
	label: "Untagged",
	position: "last",
	collapsedByDefault: true,
	// A5: a real group with a real distinct count, but never a drop target —
	// there is no such thing as "add the absence of a tag".
	droppable: false,
};

const ROOT_ROWS: NavEmptyKeyBehavior = { kind: "root-rows" };

/**
 * The ONLY place a view mode is branched on.
 *
 * A7: while a query is live the section order is relevance, full stop — the
 * Pinned section is suspended, grouping is dropped and results are ranked. It
 * all returns in the same pass that clears the query, because "searching" is
 * derived here and stored nowhere.
 */
export function resolveNavViewSpec(
	view: NavView,
	options: { tagSeparator?: string } = {},
): NavViewSpec {
	const separator = options.tagSeparator ?? NAV_PATH_SEPARATOR;
	const isSearching = view.mode === "search" && view.filter.trim().length > 0;

	if (isSearching) {
		return {
			groupBy: null,
			pinnedSection: false,
			ranked: true,
			emptyKeyBehavior: ROOT_ROWS,
			rootDropTarget: false,
			separator,
			keysForRow: () => [],
		};
	}

	if (view.groupBy === "tag") {
		return {
			groupBy: "tag",
			pinnedSection: true,
			ranked: false,
			emptyKeyBehavior: { kind: "fallback-group", group: UNTAGGED_FALLBACK },
			// A tag group means "carries this tag"; the list background means
			// "the workspace root", which is a folder idea with no tag meaning.
			rootDropTarget: false,
			separator,
			keysForRow: distinctTagKeys,
		};
	}

	return {
		groupBy: view.groupBy === "folder" ? "folder" : null,
		pinnedSection: true,
		ranked: false,
		emptyKeyBehavior: ROOT_ROWS,
		rootDropTarget: true,
		separator: NAV_PATH_SEPARATOR,
		keysForRow: view.groupBy === "folder" ? folderKeys : () => [],
	};
}

export type NavGroupNode = {
	/** Full key path from the root, e.g. `"a/b"`. Empty on the root. */
	id: string;
	/** The one separator-delimited segment this node stands for. */
	segment: string;
	/** Row label. Equals `segment` except on a fallback group. */
	label: string;
	/** Root is -1, its children 0 — the same convention as `buildTagTree`. */
	depth: number;
	/**
	 * DISTINCT document paths at or below this node. A Set, and populated on the
	 * node AND every ancestor, so a count is never a row count and never a sum
	 * of children — summing would double-count a multi-tag document (R4).
	 */
	members: Set<string>;
	/** Documents whose key terminates exactly here, in input order. */
	ownPaths: string[];
	children: NavGroupNode[];
	droppable: boolean;
	collapsedByDefault: boolean;
	isFallback: boolean;
};

function createNode(
	id: string,
	segment: string,
	depth: number,
	overrides: Partial<NavGroupNode> = {},
): NavGroupNode {
	return {
		id,
		segment,
		label: segment,
		depth,
		members: new Set<string>(),
		ownPaths: [],
		children: [],
		droppable: true,
		collapsedByDefault: false,
		isFallback: false,
		...overrides,
	};
}

function compareGroups(a: NavGroupNode, b: NavGroupNode): number {
	// A fallback bucket is pinned last whatever it is called (A5's `position`),
	// so "Untagged" cannot sort itself into the middle of the real tags.
	if (a.isFallback !== b.isFallback) return a.isFallback ? 1 : -1;
	return (
		a.segment.localeCompare(b.segment, undefined, { sensitivity: "base" }) ||
		(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	);
}

function sortTree(node: NavGroupNode): void {
	node.children.sort(compareGroups);
	for (const child of node.children) sortTree(child);
}

/**
 * Nests rows into a group tree on the spec's separator.
 *
 * R3/D2: EVERY segment gets its own node — `a/b/c` is three nodes, never one
 * compacted row. Nothing here calls or reimplements `compactFolder`.
 *
 * R4: membership is the member-union `buildTagTree` proved, generalised off
 * tags and onto `spec.keysForRow`. A path is added to its leaf and to every
 * ancestor, so `members.size` is a DISTINCT document count at every depth.
 */
export function buildGroupTree(
	rows: readonly NavDocument[],
	spec: NavViewSpec,
): NavGroupNode {
	const root = createNode("", "", -1);
	const byId = new Map<string, NavGroupNode>([["", root]]);
	// Narrowed once, here, so no pass below has to re-inspect the behaviour —
	// which is the whole point of A5 declaring it as a field.
	const fallbackGroup =
		spec.emptyKeyBehavior.kind === "fallback-group"
			? spec.emptyKeyBehavior.group
			: null;
	let fallback: NavGroupNode | null = null;

	const ensureChild = (parent: NavGroupNode, segment: string): NavGroupNode => {
		const id = parent.id ? `${parent.id}${spec.separator}${segment}` : segment;
		const existing = byId.get(id);
		if (existing) return existing;
		const node = createNode(id, segment, parent.depth + 1);
		byId.set(id, node);
		parent.children.push(node);
		return node;
	};

	const ensureFallback = (group: NavFallbackGroup): NavGroupNode => {
		if (fallback) return fallback;
		// Created lazily and never pre-seeded, so the bucket vanishes entirely
		// once every document carries a tag (EC-60).
		fallback = createNode(group.id, group.id, 0, {
			label: group.label,
			droppable: group.droppable,
			collapsedByDefault: group.collapsedByDefault,
			isFallback: true,
		});
		byId.set(group.id, fallback);
		root.children.push(fallback);
		return fallback;
	};

	for (const row of rows) {
		root.members.add(row.path);
		const keys = spec.keysForRow(row);
		if (keys.length === 0) {
			if (fallbackGroup) {
				const node = ensureFallback(fallbackGroup);
				node.members.add(row.path);
				node.ownPaths.push(row.path);
			} else {
				root.ownPaths.push(row.path);
			}
			continue;
		}
		for (const key of keys) {
			// Empty and whitespace-only segments are dropped rather than made into
			// phantom nodes that would collide on the same id (EC-44).
			const segments = key
				.split(spec.separator)
				.map((segment) => segment.trim())
				.filter((segment) => segment.length > 0);
			if (segments.length === 0) continue;
			let node = root;
			for (const segment of segments) {
				node = ensureChild(node, segment);
				node.members.add(row.path);
			}
			node.ownPaths.push(row.path);
		}
	}

	sortTree(root);
	return root;
}

/**
 * The ids to seed as expanded on a fresh tree: every real group, and never a
 * fallback bucket, which A5 ships collapsed. Separate from `flattenGroupRows`
 * on purpose — flattening reads the caller's set and nothing else, so a group
 * the user collapsed stays collapsed across a rebuild.
 */
export function defaultExpandedIds(root: NavGroupNode): Set<string> {
	const ids = new Set<string>();
	const walk = (node: NavGroupNode) => {
		for (const child of node.children) {
			if (!child.collapsedByDefault) ids.add(child.id);
			walk(child);
		}
	};
	walk(root);
	return ids;
}

export type NavGroupRow = {
	kind: "group";
	/** Row identity for React keys and the virtualizer. */
	id: string;
	groupId: string;
	segment: string;
	label: string;
	depth: number;
	expanded: boolean;
	/** Distinct documents at or below, never a row count (R4). */
	count: number;
	droppable: boolean;
	/** Which spec produced it — the drop dispatcher's discriminator. */
	specId: NavGroupBy;
	isFallback: boolean;
};

export type NavDocumentRow<T extends NavDocument = NavDocument> = {
	kind: "document";
	/** `groupId::path`, so one document under two groups is two stable rows. */
	id: string;
	doc: T;
	depth: number;
	groupId: string | null;
	isUserPinned: boolean;
};

export type NavRow<T extends NavDocument = NavDocument> =
	| NavGroupRow
	| NavDocumentRow<T>;

function documentRow<T extends NavDocument>(
	doc: T,
	groupId: string | null,
	depth: number,
): NavDocumentRow<T> {
	return {
		kind: "document",
		id: `${groupId ?? ""}::${doc.path}`,
		doc,
		depth,
		groupId,
		isUserPinned: doc.isUserPinned === true,
	};
}

/**
 * Flattens the tree into the FIXED-HEIGHT row array `useVirtualSidebarRows`
 * windows: one entry per visible row, children emitted only under expanded
 * nodes, and the Pinned section first when the spec keeps it (A7 suspends it).
 *
 * `sortedDocs` carries the order and the full row objects; the tree carries
 * only paths, so grouping never has to be redone when the sort changes.
 */
export function flattenGroupRows<T extends NavDocument>(
	tree: NavGroupNode,
	expandedIds: ReadonlySet<string>,
	sortedDocs: readonly T[],
	spec: NavViewSpec,
): NavRow<T>[] {
	const docByPath = new Map<string, T>();
	const orderByPath = new Map<string, number>();
	sortedDocs.forEach((doc, index) => {
		docByPath.set(doc.path, doc);
		orderByPath.set(doc.path, index);
	});

	const rows: NavRow<T>[] = [];

	const pushDocs = (
		paths: readonly string[],
		groupId: string | null,
		depth: number,
	) => {
		const ordered = paths
			.map((path) => docByPath.get(path))
			.filter((doc): doc is T => doc !== undefined)
			.sort(
				(a, b) =>
					(orderByPath.get(a.path) ?? 0) - (orderByPath.get(b.path) ?? 0),
			);
		for (const doc of ordered) rows.push(documentRow(doc, groupId, depth));
	};

	if (spec.pinnedSection) {
		const pinned = sortedDocs.filter((doc) => doc.isUserPinned === true);
		if (pinned.length > 0) {
			const expanded = expandedIds.has(PINNED_GROUP_ID);
			rows.push({
				kind: "group",
				id: PINNED_GROUP_ID,
				groupId: PINNED_GROUP_ID,
				segment: PINNED_GROUP_ID,
				label: "Pinned",
				depth: 0,
				expanded,
				count: pinned.length,
				// The Pinned section is not a field you can set by dropping.
				droppable: false,
				specId: spec.groupBy,
				isFallback: false,
			});
			if (expanded) {
				// A pinned document renders here AND in its own group (defect 5);
				// R4 already makes that duplication legitimate.
				for (const doc of pinned) {
					rows.push(documentRow(doc, PINNED_GROUP_ID, 1));
				}
			}
		}
	}

	const walk = (node: NavGroupNode) => {
		for (const child of node.children) {
			const expanded = expandedIds.has(child.id);
			rows.push({
				kind: "group",
				id: child.id,
				groupId: child.id,
				segment: child.segment,
				label: child.label,
				depth: child.depth,
				expanded,
				count: child.members.size,
				droppable: child.droppable,
				specId: spec.groupBy,
				isFallback: child.isFallback,
			});
			if (!expanded) continue;
			walk(child);
			pushDocs(child.ownPaths, child.id, child.depth + 1);
		}
	};
	walk(tree);
	// Documents with no key in a "root-rows" spec: after the groups, the way a
	// file explorer lists loose files below the folders.
	pushDocs(tree.ownPaths, null, 0);

	return rows;
}

/** Named states `buildNavRows` can report instead of a row model. */
export type NavRowsState = "ready" | "tags-pending";

export type NavRowsResult<T extends NavDocument> = {
	spec: NavViewSpec;
	tree: NavGroupNode;
	rows: NavRow<T>[];
	state: NavRowsState;
};

/**
 * The seam: one call from spec to rows.
 *
 * `tagsReady` is the caller's answer to "is a tag map for THIS workspace
 * available?" (`isTagScanReadyFor` in `tagScanStore.ts`). When it is false the
 * tag view reports `tags-pending` and emits NO rows, rather than grouping
 * against a missing or another workspace's map — which would render as one
 * collapsed Untagged bucket holding the whole workspace (A9, EC-39).
 */
export function buildNavRows<T extends NavDocument>({
	docs,
	view,
	expandedIds,
	tagsReady = true,
	tagSeparator,
}: {
	/** Already filtered, ranked and sorted by the caller. */
	docs: readonly T[];
	view: NavView;
	expandedIds: ReadonlySet<string>;
	tagsReady?: boolean;
	tagSeparator?: string;
}): NavRowsResult<T> {
	const spec = resolveNavViewSpec(view, { tagSeparator });
	if (spec.groupBy === "tag" && !tagsReady) {
		const tree = buildGroupTree([], spec);
		return { spec, tree, rows: [], state: "tags-pending" };
	}
	const tree = buildGroupTree(docs, spec);
	return {
		spec,
		tree,
		rows: flattenGroupRows(tree, expandedIds, docs, spec),
		state: "ready",
	};
}
