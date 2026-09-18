import { useVirtualSidebarRows } from "@mdly/workspace-kit";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
} from "react";
import { registerDocumentCloseFocus } from "../store/closeDocument";
import {
	DocumentListRow,
	type DocumentRowDensity,
	documentRowHeight,
} from "./DocumentListRow";
import type {
	DocumentTableColumn,
	DocumentTableRow,
} from "./documentTableView";

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
	/** Drives the narrow list's secondary line; unused at table density. */
	sortColumn: DocumentTableColumn;
	onOpenDocument: (row: DocumentTableRow) => void;
	/** Rendered instead of the row body when there is nothing to list. */
	emptyState: ReactNode;
	/** R9 Rail: hide the list density's secondary line. Defaults to false. */
	hideSecondary?: boolean;
};

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
 */
export function DocumentRowList({
	rows,
	density,
	sortColumn,
	onOpenDocument,
	emptyState,
	hideSecondary = false,
}: DocumentRowListProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const rowHeight = documentRowHeight(density);
	const { items, scrollToIndex } = useVirtualSidebarRows({
		rows,
		rowHeight,
		scrollRef,
	});

	const activeIndex = rows.findIndex((row) => row.isActive);
	const activePath = activeIndex === -1 ? null : rows[activeIndex].path;
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
			if (index < 0 || index >= rows.length) return;
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
		[rows.length, scrollToIndex],
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
				focusRowAt(rows.length - 1);
			}
		},
		[focusRowAt, rows.length],
	);

	const scrollClassName =
		"min-h-0 flex-1 overflow-auto overscroll-contain [padding-block:var(--row-pad-block)]";

	if (rows.length === 0) {
		// Not a `rowgroup`: an empty grid body would announce phantom structure,
		// and the message is prose. The filter box lives in the parent, outside
		// this scroll container, so it keeps its text and its focus either way.
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
				style={{ blockSize: rows.length * rowHeight }}
			>
				{items.map(({ index, row }) => (
					<DocumentListRow
						key={row.path}
						row={row}
						index={index}
						rowHeight={rowHeight}
						density={density}
						sortColumn={sortColumn}
						tabbableIndex={tabbableIndex}
						onOpenDocument={onOpenDocument}
						onRowKeyDown={onRowKeyDown}
						hideSecondary={hideSecondary}
					/>
				))}
			</div>
		</div>
	);
}
