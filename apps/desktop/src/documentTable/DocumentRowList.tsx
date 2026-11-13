import { useVirtualSidebarRows } from "@mdly/workspace-kit";
import { useStoreValue } from "@simplestack/store/react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	useCallback,
	useDeferredValue,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { desktopApi } from "../desktopApi";
import { relativeWorkspacePath } from "../lib/filePath";
import { loadPath } from "../store/actions";
import { registerDocumentCloseFocus } from "../store/closeDocument";
import {
	currentLinkIndex,
	linkIndexStore,
	resetLinkIndex,
} from "../store/linkIndexStore";
import { workspacePathStore, workspaceStore } from "../store/state";
import { useLinkIndexSync } from "../store/useLinkIndexSync";
import { DocumentGroupHeader } from "./DocumentGroupHeader";
import {
	DocumentListRow,
	type DocumentRowDensity,
	documentRowHeight,
} from "./DocumentListRow";
import { type DocumentRowListMenu, DocumentRowMenu } from "./DocumentRowMenu";
import {
	narrowGridStyleFor,
	useDocumentTableLayout,
} from "./documentTableLayout";
import {
	buildDocumentRows,
	type DocumentTableRow,
	type DocumentTableView,
	ROOT_FOLDER_LABEL,
} from "./documentTableView";
import { anchoredScrollTop, takeScrollAnchor } from "./layoutTransition";
import { type NavDensityTier, navIndentRem } from "./navDensity";
import { setNavExpandedIds } from "./navExpandedGroups";
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
} from "./navGroupTree";
import { isPathGroupBy, PATH_GROUP_BY } from "./properties/documentViews";
import {
	buildPathGroupTree,
	linkedFromGroupSource,
} from "./properties/pathGroupTree";
import { buildPropertyGroupTree } from "./properties/propertyGroupTree";
import { useLocalDayKey } from "./properties/useLocalDayKey";
import { usePropertyModel } from "./properties/usePropertyModel";
import { TagScanStateView } from "./TagScanState";
import {
	beginTagScan,
	completeTagScan,
	failTagScan,
	isTagScanReadyFor,
	resetTagScan,
	tagScanPathsToScan,
	tagScanStore,
	tagsForScope,
} from "./tagScanStore";
import { useNavViewSwitcher } from "./useNavViewSwitcher";

export {
	DOCUMENT_CARD_ROW_HEIGHT,
	DOCUMENT_CARD_TIER_ROW_HEIGHT,
	DOCUMENT_LIST_ROW_HEIGHT,
	DOCUMENT_NARROW_TABLE_ROW_HEIGHT,
	DOCUMENT_TABLE_GRID_TEMPLATE,
	DOCUMENT_TABLE_ROW_HEIGHT,
	type DocumentRowDensity,
	documentRowHeight,
	formatCardDate,
	formatCreatedAt,
	formatCreatedAtTitle,
	formatModifiedAt,
	formatModifiedAtTitle,
} from "./DocumentListRow";

/**
 * Frames a keyboard jump waits for the virtualizer to render its target row.
 * Five is ~80ms — long enough for a scroll-driven re-render to commit, short
 * enough that a genuinely missing row gives up instead of looping.
 */
const FOCUS_RETRY_FRAMES = 5;

type DocumentRowListProps = {
	rows: DocumentTableRow[];
	density: DocumentRowDensity;
	onOpenDocument: (row: DocumentTableRow) => void;
	/** Rendered instead of the row body when there is nothing to list. */
	emptyState: ReactNode;
	/** R9 Rail: hide the list density's secondary line. Defaults to false. */
	hideSecondary?: boolean;
	/**
	 * Wide peek list: keep the list density's row height but render each row
	 * as one-line table cells (under a column header the caller renders).
	 */
	gridCells?: boolean;
	/**
	 * R2: the grouping query. Absent means the flat list — every existing
	 * caller without a view renders exactly as before.
	 */
	view?: DocumentTableView;
	/**
	 * Title-column menu, wired by the host to the same file actions the
	 * sidebar rows offer. Absent in unit tests that only exercise layout and
	 * keyboard behaviour.
	 */
	menu?: DocumentRowListMenu;
	/**
	 * Peek-list density tier. Only read at `list` density: `card`/`table`
	 * widen the rows into wrapped cards. Defaults to `list`.
	 */
	navTier?: NavDensityTier;
};

/** The engine's document shape over the table's own row: identity preserved. */
type GroupableRow = DocumentTableRow & NavDocument;

function collectGroupIds(root: NavGroupNode): Set<string> {
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

/**
 * Every group on the path to `docPath`, from the top-level group down to its
 * leaf. Membership is recorded on each node AND every ancestor
 * (`buildGroupTree`), so collecting the nodes that contain the path yields
 * exactly its chain — one chain in the folder view, one per tag in the tag
 * view.
 */
function ancestorGroupIdsForPath(
	root: NavGroupNode,
	docPath: string,
): Set<string> {
	const ids = new Set<string>();
	const walk = (node: NavGroupNode) => {
		for (const child of node.children) {
			if (!child.members.has(docPath)) continue;
			ids.add(child.id);
			walk(child);
		}
	};
	walk(root);
	return ids;
}

/**
 * The one row surface, at two densities.
 *
 * Rows are absolutely positioned at `translateY(index * rowHeight)` using the
 * virtualizer's **absolute** index, and the spacer paddings it also returns are
 * deliberately ignored. That makes the R4 re-sort glide fall out of the data:
 * when a row's index changes, its transform changes, and one CSS transition
 * animates it. No measurement pass, no FLIP hook, and nothing on the render or
 * re-sort path writes `scrollTop`, so a live re-sort can never scroll-jump under
 * the user. (Keyboard navigation does scroll, through `scrollToIndex` below, but
 * only ever in response to the user's own arrow key.)
 *
 * Markup is a CSS grid of `<button>` rows rather than a `<table>`: transforms
 * are unreliable on `<tr>`, and a grid lets the full table and the narrow list
 * be literally the same component.
 *
 * R2: when `view` groups, the flat rows go through `buildNavRows` first and
 * the list renders group headers interleaved with documents. Headers share
 * the list's one fixed row height, so the windowing math below is unaffected.
 */
export function DocumentRowList({
	rows,
	density,
	onOpenDocument,
	emptyState,
	hideSecondary = false,
	gridCells = false,
	view,
	menu,
	navTier = "list",
}: DocumentRowListProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	// Horizontal swipe anywhere over the list flips the nav view (recent /
	// folder / tag); vertical scroll is untouched.
	const { swipeRef } = useNavViewSwitcher();
	const listRef = useCallback(
		(element: HTMLDivElement | null) => {
			scrollRef.current = element;
			swipeRef(element);
		},
		[swipeRef],
	);
	const rowHeight = documentRowHeight(
		density,
		density === "list" ? navTier : "list",
	);
	// Live column order + widths (one store shared with the table header).
	// The narrow list's secondary line is the first data column in this order;
	// the card tiers wrap every data column in that same order.
	const { columns, gridStyle, secondaryColumn, propertyColumns } =
		useDocumentTableLayout();
	const metaColumns = useMemo(
		() => columns.filter((column) => column !== "name"),
		[columns],
	);

	const workspacePath = useStoreValue(workspacePathStore);
	const pinnedNotes = useStoreValue(
		workspaceStore,
		(workspace) => workspace.pinnedNotes,
	);
	const storedExpandedIds = useStoreValue(workspaceStore, (workspace) =>
		workspacePath ? (workspace.navExpandedGroups[workspacePath] ?? null) : null,
	);
	const workspaceFiles = useStoreValue(
		workspaceStore,
		(workspace) => workspace.files,
	);
	const tagScanState = useStoreValue(tagScanStore);

	const navView: NavView = useMemo(
		() => ({
			groupBy: view?.groupBy ?? null,
			mode: view?.mode ?? "browse",
			filter: view?.filter ?? "",
		}),
		[view?.groupBy, view?.mode, view?.filter],
	);
	const spec = useMemo(() => resolveNavViewSpec(navView), [navView]);
	const scanScope = workspacePath ?? null;
	const tagsByPath = tagsForScope(tagScanState, scanScope);
	const tagsReady = isTagScanReadyFor(tagScanState, scanScope);
	const navDocs = useMemo<GroupableRow[]>(
		() =>
			rows.map((row) => ({
				...row,
				folderPath:
					row.folderLabel === ROOT_FOLDER_LABEL ? "" : row.folderLabel,
				tags: tagsByPath?.[row.path],
				isUserPinned: pinnedNotes.includes(row.path),
			})),
		[rows, tagsByPath, pinnedNotes],
	);

	// The tree is built twice — once here for the expansion defaults, once
	// inside `buildNavRows`. Kept because the seam owns flattening and the
	// defaults need the tree before the set can be merged.
	const tree = useMemo(() => buildGroupTree(navDocs, spec), [navDocs, spec]);
	const prevGroupIdsRef = useRef<Set<string> | null>(null);
	const expandedIds = useMemo(() => {
		const defaults = defaultExpandedIds(tree);
		const stored = storedExpandedIds;
		let merged: Set<string>;
		if (stored === null) {
			merged = new Set(defaults);
		} else {
			merged = new Set(stored);
			const prev = prevGroupIdsRef.current;
			if (prev) {
				// Groups that did not exist on the last build keep their
				// default: a new folder arrives expanded, a collapsed one stays
				// collapsed, and Untagged stays collapsed until toggled.
				for (const id of defaults) if (!prev.has(id)) merged.add(id);
			}
		}
		prevGroupIdsRef.current = collectGroupIds(tree);
		return merged;
		// storedExpandedIds already encodes the workspace through its selector,
		// so the workspace itself is not a separate dependency.
	}, [tree, storedExpandedIds]);
	// Group-by-property replaces folder/tag grouping while set; a live search
	// still drops all grouping (A7), exactly like the nav views.
	const { fields: propertyFields } = usePropertyModel();
	const isSearching =
		navView.mode === "search" && navView.filter.trim().length > 0;
	const propertyGroupBy =
		!isSearching && view?.propertyGroupBy ? view.propertyGroupBy : null;
	// Regrouping 50k rows costs ~30-50 ms; defer it so typing in the filter
	// box stays responsive while grouped (React renders the stale groups first).
	const deferredNavDocs = useDeferredValue(navDocs);
	const groupedDocs = propertyGroupBy ? deferredNavDocs : navDocs;
	// Date-range groups are relative to today: rebuilt when the day rolls over.
	const dayKey = useLocalDayKey();
	// "Linked from" reads the workspace link index (the Backlinks submenu's),
	// starting it here when nothing has yet.
	const wantsLinks = propertyGroupBy === PATH_GROUP_BY.linkedFrom;
	useLinkIndexSync(wantsLinks);
	const linkIndexState = useStoreValue(linkIndexStore);
	const linksReady =
		linkIndexState.scope === (workspacePath ?? null) &&
		linkIndexState.status === "ready";
	const linkVersion = wantsLinks ? linkIndexState.version : 0;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `linkVersion` is the change signal for the mutable link index.
	const propertyTree = useMemo(
		() =>
			propertyGroupBy && isPathGroupBy(propertyGroupBy)
				? buildPathGroupTree(
						groupedDocs,
						propertyGroupBy,
						propertyGroupBy === PATH_GROUP_BY.linkedFrom
							? currentLinkIndex()
							: undefined,
					)
				: propertyGroupBy
					? buildPropertyGroupTree(
							groupedDocs,
							propertyGroupBy,
							propertyFields,
							// Buckets depend only on the day; noon of it is that day.
							new Date(`${dayKey}T12:00:00`),
						)
					: null,
		[groupedDocs, propertyGroupBy, propertyFields, dayKey, linkVersion],
	);
	// Session-only collapse state: property groups start expanded (a board's
	// columns are all visible), and the user's collapses last until relaunch.
	const [collapsedPropertyGroups, setCollapsedPropertyGroups] = useState<
		ReadonlySet<string>
	>(() => new Set());
	const navRows = useMemo(() => {
		if (propertyTree) {
			const expanded = new Set(
				propertyTree.children
					.map((child) => child.id)
					.filter((id) => !collapsedPropertyGroups.has(id)),
			);
			if (expandedIds.has(PINNED_GROUP_ID)) expanded.add(PINNED_GROUP_ID);
			return flattenGroupRows(propertyTree, expanded, groupedDocs, spec);
		}
		return buildNavRows({
			docs: navDocs,
			view: navView,
			expandedIds,
			tagsReady,
		}).rows;
	}, [
		propertyTree,
		collapsedPropertyGroups,
		groupedDocs,
		navDocs,
		spec,
		navView,
		expandedIds,
		tagsReady,
	]);

	const toggleGroup = useCallback(
		(groupId: string) => {
			if (propertyTree && groupId !== PINNED_GROUP_ID) {
				setCollapsedPropertyGroups((collapsed) => {
					const next = new Set(collapsed);
					if (next.has(groupId)) next.delete(groupId);
					else next.add(groupId);
					return next;
				});
				return;
			}
			if (!workspacePath) return;
			const next = new Set(expandedIds);
			if (next.has(groupId)) next.delete(groupId);
			else next.add(groupId);
			setNavExpandedIds(workspacePath, [...next]);
		},
		[workspacePath, expandedIds, propertyTree],
	);

	// A9's reader: the tag view's actual scan. Entering the tag view — or a file
	// changing while it is open — diffs the workspace listing against the store
	// and reads the head of only the paths that need it, then completes (or
	// fails) the scan. The scope lives in the store, so a result for a workspace
	// the user already left is dropped instead of painted here.
	const tagScanRequestRef = useRef(0);
	// A saved view grouped by Tag needs the same map as the nav Tag view.
	const wantsTags =
		spec.groupBy === "tag" || propertyGroupBy === PATH_GROUP_BY.tag;
	useEffect(() => {
		if (!wantsTags || !workspacePath) return;
		// A scan already in flight for this workspace is left alone; a failed
		// one waits for the user's "Try again" (which resets to idle) rather
		// than looping on the failure.
		if (
			tagScanState.kind === "scanning" &&
			tagScanState.scope === workspacePath
		)
			return;
		if (tagScanState.kind === "failed" && tagScanState.scope === workspacePath)
			return;
		const files = buildDocumentRows(workspaceFiles, workspacePath).map(
			(row) => ({ path: row.path, modifiedAt: row.modifiedAt }),
		);
		const paths = tagScanPathsToScan(tagScanState, workspacePath, files);
		if (paths.length === 0) {
			// Nothing to read: still settle out of the pending state (an empty
			// workspace, or a refresh that changed nothing) so the view does not
			// read "Reading tags…" forever.
			if (!isTagScanReadyFor(tagScanState, workspacePath)) {
				beginTagScan(workspacePath);
				completeTagScan({
					scope: workspacePath,
					files,
					scannedPaths: [],
					tags: {},
				});
			}
			return;
		}
		beginTagScan(workspacePath);
		const request = ++tagScanRequestRef.current;
		void desktopApi.scanFrontMatterTags(paths).then(
			(tags) => {
				if (tagScanRequestRef.current !== request) return;
				completeTagScan({
					scope: workspacePath,
					files,
					scannedPaths: paths,
					tags,
				});
			},
			(error: unknown) => {
				if (tagScanRequestRef.current !== request) return;
				failTagScan(
					workspacePath,
					error instanceof Error ? error.message : String(error),
				);
			},
		);
	}, [wantsTags, tagScanState, workspacePath, workspaceFiles]);

	// A view switch lands at the top of the new view, not at the old view's
	// scroll offset clamped into a different-length list.
	// biome-ignore lint/correctness/useExhaustiveDependencies: grouping is the trigger, not a value read here
	useEffect(() => {
		if (scrollRef.current) scrollRef.current.scrollTop = 0;
	}, [spec.groupBy]);

	const retryTagScan = useCallback(() => {
		resetTagScan();
	}, []);

	const { items, scrollToIndex } = useVirtualSidebarRows({
		rows: navRows,
		rowHeight,
		scrollRef,
	});
	// Which row's "..." menu is open, by path. Right-clicking a row opens the
	// same menu the trigger does — exactly how the sidebar's row menu behaves.
	const [openMenuPath, setOpenMenuPath] = useState<string | null>(null);

	const activeIndex = navRows.findIndex(
		(navRow) => navRow.kind === "document" && navRow.doc.isActive,
	);
	const activeRow = activeIndex === -1 ? null : navRows[activeIndex];
	const activePath =
		activeRow && activeRow.kind === "document" ? activeRow.doc.path : null;
	// The open document's path, whether or not its row is currently rendered:
	// `activePath` above is null while a collapsed group hides the row, which
	// is exactly when the reveal below has work to do.
	const openPath = rows.find((row) => row.isActive)?.path ?? null;
	// The index is read through a ref so the effect below can depend on *which
	// document is open* and nothing else. The sidebar keys the same effect on the
	// index (`Sidebar.tsx`), which it can afford because its rows never reorder
	// on their own; here R4 re-sorts live, and an index-keyed effect would scroll
	// the viewport out from under a reading user on every watcher event.
	const activeIndexRef = useRef(activeIndex);
	activeIndexRef.current = activeIndex;

	// Opening a document from anywhere but this list — the command palette, a
	// wiki link, Finder — leaves its row wherever the sort put it, which on a
	// large workspace is far below the fold. Without this the list reads as
	// having no selection at all. The hidden/shown key (rather than the index)
	// is what refires the scroll after a collapsed group expands below or a
	// tag scan completes: a live re-sort under the same open document stays
	// shown -> shown and never yanks the viewport.
	const activeVisibility = activeIndex === -1 ? "hidden" : "shown";
	// A table <-> peek switch (layoutTransition.ts) hands over the clicked
	// row's on-screen offset; land it at the same height in this new list.
	// Layout effect, so it lands inside the transition's flushSync and the new
	// snapshot already shows it. Keyed by path, not "open document", so the
	// full table (no active row) can anchor the row that was just closed.
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-only handoff
	useLayoutEffect(() => {
		const scrollEl = scrollRef.current;
		const anchor = takeScrollAnchor();
		if (!scrollEl || !anchor) return;
		const index = navRows.findIndex(
			(navRow) => navRow.kind === "document" && navRow.doc.path === anchor.path,
		);
		if (index === -1) return;
		scrollEl.scrollTop = anchoredScrollTop({
			index,
			rowHeight,
			offset: anchor.offset,
			clientHeight: scrollEl.clientHeight,
			contentHeight: navRows.length * rowHeight,
		});
	}, []);
	useEffect(() => {
		if (activePath === null || activeVisibility === "hidden") return;
		scrollToIndex(activeIndexRef.current);
	}, [activePath, activeVisibility, scrollToIndex]);

	// The open document can live inside a group the user collapsed (or the
	// collapsed Untagged bucket): then its row is not in `navRows` at all, so
	// there is nothing to highlight or scroll to. Expanding only its own
	// ancestor chain, once per opened path, leaves every other manual
	// collapse exactly as the user left it.
	const revealedDocPathRef = useRef<string | null>(null);
	const revealedDocScopeRef = useRef(workspacePath);
	if (revealedDocScopeRef.current !== workspacePath) {
		revealedDocScopeRef.current = workspacePath;
		revealedDocPathRef.current = null;
	}
	useEffect(() => {
		if (openPath === null) return;
		if (revealedDocPathRef.current === openPath) return;
		revealedDocPathRef.current = openPath;
		if (activeIndex !== -1 || !workspacePath) return;
		const ancestors = ancestorGroupIdsForPath(tree, openPath);
		if (ancestors.size === 0) return;
		const next = new Set(expandedIds);
		let changed = false;
		for (const id of ancestors) {
			if (next.has(id)) continue;
			next.add(id);
			changed = true;
		}
		if (changed) setNavExpandedIds(workspacePath, [...next]);
	}, [openPath, activeIndex, tree, expandedIds, workspacePath]);

	// Closing a document leaves focus on `<body>`, so Tab would restart from the
	// top of the window instead of continuing in the list the user is now looking
	// at. `closeDocumentToTable` fires this *synchronously*, while this list is
	// still the narrow one — the full-width table has not rendered yet — so the
	// focus has to wait a frame, and the row is found by a document-wide query
	// rather than through this instance's `scrollRef`, which by then belongs to
	// an unmounted list. Exactly one row list is ever mounted, and exactly one of
	// its rows is tabbable, so the query cannot be ambiguous.
	useEffect(
		() =>
			registerDocumentCloseFocus(() => {
				requestAnimationFrame(() => {
					document
						.querySelector<HTMLElement>(
							'[data-document-row-index][tabindex="0"]',
						)
						?.focus();
				});
			}),
		[],
	);

	const focusRowAt = useCallback(
		(index: number) => {
			if (index < 0 || index >= navRows.length) return;
			scrollToIndex(index);
			const focusRendered = () => {
				const rowEl = scrollRef.current?.querySelector<HTMLElement>(
					`[data-document-row-index="${index}"]`,
				);
				rowEl?.focus();
				return rowEl !== null && rowEl !== undefined;
			};
			// A neighbouring row is already in the virtual window, so focus lands on
			// this frame and a held arrow key never drops a keystroke. A jump past the
			// overscan (Home/End on a long list) only materialises the target row once
			// `scrollToIndex`'s scroll event has re-rendered the virtualizer, and that
			// is not guaranteed to commit within a single frame — so retry over a few.
			if (focusRendered()) return;
			let framesLeft = FOCUS_RETRY_FRAMES;
			const retry = () => {
				if (focusRendered() || --framesLeft <= 0) return;
				requestAnimationFrame(retry);
			};
			requestAnimationFrame(retry);
		},
		[navRows.length, scrollToIndex],
	);

	const onRowKeyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLElement>, index: number) => {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				focusRowAt(index + 1);
			} else if (event.key === "ArrowUp") {
				event.preventDefault();
				focusRowAt(index - 1);
			} else if (event.key === "Home") {
				event.preventDefault();
				focusRowAt(0);
			} else if (event.key === "End") {
				event.preventDefault();
				focusRowAt(navRows.length - 1);
			}
		},
		[focusRowAt, navRows.length],
	);

	// "Linked from" labels are file names: two linkers sharing one (a/index,
	// b/index) show their workspace-relative path instead, so they differ.
	const linkedFromLabels = useMemo(() => {
		if (!wantsLinks || !propertyTree) return null;
		const counts = new Map<string, number>();
		for (const child of propertyTree.children)
			counts.set(child.label, (counts.get(child.label) ?? 0) + 1);
		const labels = new Map<string, string>();
		for (const child of propertyTree.children) {
			const source = linkedFromGroupSource(child.id);
			if (!source) continue;
			const relative = relativeWorkspacePath(source, workspacePath ?? null);
			labels.set(
				child.id,
				(counts.get(child.label) ?? 0) > 1
					? relative.replace(/\.(md|markdown)$/i, "")
					: child.label,
			);
			labels.set(`${child.id}\u0000title`, relative);
		}
		return labels;
	}, [wantsLinks, propertyTree, workspacePath]);

	// A "Linked from" group's title opens the linking document.
	const openGroupSource = (groupId: string) => {
		const source = wantsLinks ? linkedFromGroupSource(groupId) : null;
		return source ? () => void loadPath(source) : undefined;
	};

	const scrollClassName =
		"min-h-0 flex-1 overflow-auto overscroll-contain [padding-block:var(--row-pad-block)]";

	if (propertyGroupBy === PATH_GROUP_BY.tag && !tagsReady) {
		// Grouping by Tag before the scan lands would put every document in
		// "Other"; hold the groups until the tags are known.
		const failed =
			tagScanState.kind === "failed" && tagScanState.scope === scanScope;
		return (
			<div ref={swipeRef} className={scrollClassName}>
				<div className="p-2">
					<TagScanStateView
						status={failed ? "failed" : "scanning"}
						scanningText="Scanning tags…"
						onRetry={retryTagScan}
					/>
				</div>
			</div>
		);
	}

	if (wantsLinks && !linksReady) {
		// Same hold as Tag: no all-"Other" list before the links are known.
		return (
			<div ref={swipeRef} className={scrollClassName}>
				<div className="p-2">
					<TagScanStateView
						status={linkIndexState.status === "failed" ? "failed" : "scanning"}
						scanningText="Scanning links…"
						onRetry={resetLinkIndex}
					/>
				</div>
			</div>
		);
	}

	if (navRows.length === 0) {
		// Not a `rowgroup`: an empty grid body would announce phantom structure,
		// and the message is prose. The filter box lives in the parent, outside
		// this scroll container, so it keeps its text and its focus either way.
		if (spec.groupBy === "tag" && !tagsReady) {
			// A9: zero groups while scanning or failed — no Untagged bucket in
			// either state — in the narrow list's own visual shape.
			const failed =
				tagScanState.kind === "failed" && tagScanState.scope === scanScope;
			return (
				<div ref={swipeRef} className={scrollClassName}>
					<div className="p-2">
						{failed ? (
							<TagScanStateView status="failed" onRetry={retryTagScan} />
						) : (
							<TagScanStateView status="scanning" onRetry={retryTagScan} />
						)}
					</div>
				</div>
			);
		}
		return (
			<div ref={swipeRef} className={scrollClassName}>
				{emptyState}
			</div>
		);
	}

	// Roving tabindex: one row is in the tab order, arrows move within the grid.
	// Virtualization makes "the active row, else row 0" unsafe — either can sit
	// outside the rendered window, and then *no* row in the DOM carries
	// `tabIndex=0` and Tab skips the whole list. Clamping into the window keeps
	// exactly one rendered row tabbable, and makes it the one nearest the
	// selection. `items` is contiguous, so its ends are the window's bounds.
	const firstRenderedIndex = items[0]?.index ?? 0;
	const lastRenderedIndex = items[items.length - 1]?.index ?? 0;
	const tabbableIndex = Math.min(
		Math.max(activeIndex === -1 ? 0 : activeIndex, firstRenderedIndex),
		lastRenderedIndex,
	);

	return (
		<div ref={listRef} role="rowgroup" className={scrollClassName}>
			<div
				role="presentation"
				className="relative"
				style={{ blockSize: navRows.length * rowHeight }}
			>
				{items.map(({ index, row: navRow }) =>
					navRow.kind === "group" ? (
						<DocumentGroupHeader
							key={navRow.id}
							label={linkedFromLabels?.get(navRow.groupId) ?? navRow.label}
							sourceTitle={linkedFromLabels?.get(
								`${navRow.groupId}\u0000title`,
							)}
							count={navRow.count}
							depth={navRow.depth}
							expanded={navRow.expanded}
							onToggle={() => toggleGroup(navRow.groupId)}
							specId={navRow.specId}
							groupId={navRow.groupId}
							onOpenSource={openGroupSource(navRow.groupId)}
							index={index}
							ariaRowIndex={
								density === "table" || gridCells ? index + 2 : index + 1
							}
							tabIndex={index === tabbableIndex ? 0 : -1}
							rowHeight={rowHeight}
							onKeyDown={(event) => {
								// Group headers are never tag drag sources — and
								// never drop targets through this surface either.
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									toggleGroup(navRow.groupId);
								} else {
									onRowKeyDown(event, index);
								}
							}}
						/>
					) : (
						// `contents` keeps the menu trigger's `group/document-row`
						// hover working with zero layout or accessibility impact.
						<div
							key={navRow.id}
							role="presentation"
							className="contents group/document-row"
						>
							<DocumentListRow
								row={navRow.doc}
								index={index}
								rowHeight={rowHeight}
								density={gridCells ? "table" : density}
								columns={columns}
								gridStyle={gridCells ? narrowGridStyleFor(columns) : gridStyle}
								secondaryColumn={secondaryColumn}
								tabbableIndex={tabbableIndex}
								onOpenDocument={onOpenDocument}
								onRowKeyDown={onRowKeyDown}
								hideSecondary={hideSecondary}
								navTier={navTier}
								metaColumns={metaColumns}
								tags={navRow.doc.tags}
								sortColumn={view?.sort.column}
								hasMenu={menu != null}
								propertyColumns={
									density === "table" && !gridCells
										? propertyColumns
										: undefined
								}
								// A10: a leaf sits one level under its group header, so
								// it carries the same depth inset — the folder/tag tree
								// reads as a tree. The flat list has `groupBy === null`
								// and keeps a zero inset.
								indentRem={spec.groupBy ? navIndentRem(navRow.depth) : 0}
								onContextMenu={
									menu
										? (event) => {
												event.preventDefault();
												setOpenMenuPath(navRow.doc.path);
											}
										: undefined
								}
							/>
							{menu ? (
								<div
									className="absolute end-0.5 top-0 flex items-center"
									style={{
										transform: `translateY(${index * rowHeight}px)`,
										blockSize: rowHeight,
									}}
								>
									<DocumentRowMenu
										row={navRow.doc}
										pinned={menu.isPinned(navRow.doc.path)}
										revealLabel={menu.revealLabel}
										open={openMenuPath === navRow.doc.path}
										onOpenChange={(open) =>
											setOpenMenuPath(open ? navRow.doc.path : null)
										}
										handlers={menu}
									/>
								</div>
							) : null}
						</div>
					),
				)}
			</div>
		</div>
	);
}
