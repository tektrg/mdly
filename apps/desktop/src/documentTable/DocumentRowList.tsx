import { useVirtualSidebarRows } from "@mdly/workspace-kit";
import { useStoreValue } from "@simplestack/store/react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
} from "react";
import { registerDocumentCloseFocus } from "../store/closeDocument";
import { workspacePathStore, workspaceStore } from "../store/state";
import { DocumentGroupHeader } from "./DocumentGroupHeader";
import {
	DocumentListRow,
	type DocumentRowDensity,
	documentRowHeight,
} from "./DocumentListRow";
import { useDocumentTableLayout } from "./documentTableLayout";
import {
	type DocumentTableRow,
	type DocumentTableView,
	ROOT_FOLDER_LABEL,
} from "./documentTableView";
import { setNavExpandedIds } from "./navExpandedGroups";
import {
	buildGroupTree,
	buildNavRows,
	defaultExpandedIds,
	type NavDocument,
	type NavGroupNode,
	type NavView,
	resolveNavViewSpec,
} from "./navGroupTree";
import { TagScanStateView } from "./TagScanState";
import {
	beginTagScan,
	isTagScanReadyFor,
	resetTagScan,
	tagScanStore,
	tagsForScope,
} from "./tagScanStore";

export {
	DOCUMENT_LIST_ROW_HEIGHT,
	DOCUMENT_TABLE_GRID_TEMPLATE,
	DOCUMENT_TABLE_ROW_HEIGHT,
	type DocumentRowDensity,
	documentRowHeight,
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
	 * R2: the grouping query. Absent means the flat list — every existing
	 * caller without a view renders exactly as before.
	 */
	view?: DocumentTableView;
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
	view,
}: DocumentRowListProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const rowHeight = documentRowHeight(density);
	// Live column order + widths (one store shared with the table header).
	// The narrow list's secondary line is the first data column in this order.
	const { columns, gridStyle, secondaryColumn } = useDocumentTableLayout();

	const workspacePath = useStoreValue(workspacePathStore);
	const pinnedNotes = useStoreValue(
		workspaceStore,
		(workspace) => workspace.pinnedNotes,
	);
	const storedExpandedIds = useStoreValue(workspaceStore, (workspace) =>
		workspacePath ? (workspace.navExpandedGroups[workspacePath] ?? null) : null,
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
	const navRows = useMemo(
		() =>
			buildNavRows({
				docs: navDocs,
				view: navView,
				expandedIds,
				tagsReady,
			}).rows,
		[navDocs, navView, expandedIds, tagsReady],
	);

	const toggleGroup = useCallback(
		(groupId: string) => {
			if (!workspacePath) return;
			const next = new Set(expandedIds);
			if (next.has(groupId)) next.delete(groupId);
			else next.add(groupId);
			setNavExpandedIds(workspacePath, [...next]);
		},
		[workspacePath, expandedIds],
	);

	// A9: entering the tag view starts a scan for this workspace. Fires from
	// idle and when the store still holds another workspace's outcome — never
	// when this workspace is already scanning, failed or scanned.
	useEffect(() => {
		if (spec.groupBy !== "tag" || !workspacePath) return;
		const scope = tagScanState.kind === "idle" ? undefined : tagScanState.scope;
		if (scope !== workspacePath) beginTagScan(workspacePath);
	}, [spec.groupBy, tagScanState, workspacePath]);

	const retryTagScan = useCallback(() => {
		resetTagScan();
	}, []);

	const { items, scrollToIndex } = useVirtualSidebarRows({
		rows: navRows,
		rowHeight,
		scrollRef,
	});

	const activeIndex = navRows.findIndex(
		(navRow) => navRow.kind === "document" && navRow.doc.isActive,
	);
	const activeRow = activeIndex === -1 ? null : navRows[activeIndex];
	const activePath =
		activeRow && activeRow.kind === "document" ? activeRow.doc.path : null;
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
	// having no selection at all.
	useEffect(() => {
		if (activePath === null) return;
		scrollToIndex(activeIndexRef.current);
	}, [activePath, scrollToIndex]);

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

	const scrollClassName =
		"min-h-0 flex-1 overflow-auto overscroll-contain [padding-block:var(--row-pad-block)]";

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
				<div className={scrollClassName}>
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
		return <div className={scrollClassName}>{emptyState}</div>;
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
		<div ref={scrollRef} role="rowgroup" className={scrollClassName}>
			<div
				role="presentation"
				className="relative"
				style={{ blockSize: navRows.length * rowHeight }}
			>
				{items.map(({ index, row: navRow }) =>
					navRow.kind === "group" ? (
						<DocumentGroupHeader
							key={navRow.id}
							label={navRow.label}
							count={navRow.count}
							depth={navRow.depth}
							expanded={navRow.expanded}
							onToggle={() => toggleGroup(navRow.groupId)}
							specId={navRow.specId}
							groupId={navRow.groupId}
							index={index}
							ariaRowIndex={density === "table" ? index + 2 : index + 1}
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
						<DocumentListRow
							key={navRow.id}
							row={navRow.doc}
							index={index}
							rowHeight={rowHeight}
							density={density}
							columns={columns}
							gridStyle={gridStyle}
							secondaryColumn={secondaryColumn}
							tabbableIndex={tabbableIndex}
							onOpenDocument={onOpenDocument}
							onRowKeyDown={onRowKeyDown}
							hideSecondary={hideSecondary}
						/>
					),
				)}
			</div>
		</div>
	);
}
