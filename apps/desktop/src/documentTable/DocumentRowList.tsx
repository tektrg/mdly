import {
	formatRevisionTime,
	SIDEBAR_VIRTUAL_ROW_HEIGHT,
	useVirtualSidebarRows,
} from "@mdly/workspace-kit";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
} from "react";
import { cn } from "../lib/utils";
import { registerDocumentCloseFocus } from "../store/closeDocument";
import type {
	DocumentTableColumn,
	DocumentTableRow,
} from "./documentTableView";

/**
 * Full-table density: the same 28px rhythm the sidebar uses, so the two lists
 * read as one app.
 */
export const DOCUMENT_TABLE_ROW_HEIGHT = SIDEBAR_VIRTUAL_ROW_HEIGHT;
/**
 * Narrow-list density. Taller than the table row because the narrow list stacks
 * a secondary metadata line under the name — at `w-64` there is no room to put
 * it on the same line without truncating the document name to nothing.
 */
export const DOCUMENT_LIST_ROW_HEIGHT = 44;

/**
 * Shared by the header row and the body rows so the two grids cannot drift.
 * Written as a literal (not composed at runtime) because Tailwind only emits
 * classes it can see in the source text.
 */
export const DOCUMENT_TABLE_GRID_TEMPLATE =
	"grid grid-cols-[minmax(0,1fr)_minmax(0,11rem)_minmax(0,10rem)] items-center gap-2";

/**
 * Frames a keyboard jump waits for the virtualizer to render its target row.
 * Five is ~80ms — long enough for a scroll-driven re-render to commit, short
 * enough that a genuinely missing row gives up instead of looping.
 */
const FOCUS_RETRY_FRAMES = 5;

export type DocumentRowDensity = "table" | "list";

export function documentRowHeight(density: DocumentRowDensity): number {
	return density === "table"
		? DOCUMENT_TABLE_ROW_HEIGHT
		: DOCUMENT_LIST_ROW_HEIGHT;
}

const TIME_OF_DAY = new Intl.DateTimeFormat(undefined, {
	hour: "numeric",
	minute: "2-digit",
});
const DAY_THIS_YEAR = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	month: "short",
});
const DAY_WITH_YEAR = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	month: "short",
	year: "numeric",
});

/**
 * A Modified column is scanned for recency, not read for precision, so it drops
 * whatever the reader can already infer: today's rows show only a time, this
 * year's drop the year. The full timestamp stays reachable as the cell's title.
 * `FileEntry.modified_at` is seconds; the kit's formatter takes milliseconds.
 */
export function formatModifiedAt(modifiedAt: number, now = new Date()): string {
	const at = new Date(modifiedAt * 1000);
	if (Number.isNaN(at.getTime())) return "";
	if (at.toDateString() === now.toDateString()) return TIME_OF_DAY.format(at);
	if (at.getFullYear() === now.getFullYear()) return DAY_THIS_YEAR.format(at);
	return DAY_WITH_YEAR.format(at);
}

/** The precise timestamp, shown on hover so the compact label stays unambiguous. */
export function formatModifiedAtTitle(modifiedAt: number): string {
	return formatRevisionTime(modifiedAt * 1000);
}

/**
 * The narrow list shows whichever column the table is sorted by, so the sort
 * the user chose stays legible after the table collapses (O10/O17).
 */
function secondaryLabel(
	row: DocumentTableRow,
	sortColumn: DocumentTableColumn,
): string {
	return sortColumn === "modified"
		? formatModifiedAt(row.modifiedAt)
		: row.folderLabel;
}

/**
 * Folder and Modified are the table's *content*, not decoration, so they have to
 * stay readable — including on the highlighted row.
 *
 * Two things were wrong before. `text-muted-foreground/70` composites the muted
 * colour onto whatever is behind it, which bottomed out at 1.98:1 in light/soft
 * — WCAG AA wants 4.5:1. And on the active row it kept using the *muted* colour
 * over the darker `--selected` surface, making the worst case worse. Idle rows
 * now use the design system's muted colour at full strength (3.7:1 to 10.8:1
 * across the six permutations — the same level as every other muted label in the
 * app), and the active row inherits `--selected-foreground`, which measures
 * 7.1:1 or better in all six. 11px matches the column header above it; at 10px
 * the body text was smaller than its own heading.
 */
function secondaryTextClass(isActive: boolean): string {
	return cn(
		"min-w-0 truncate text-[11px]",
		isActive ? "text-selected-foreground" : "text-muted-foreground",
	);
}

type DocumentRowListProps = {
	rows: DocumentTableRow[];
	density: DocumentRowDensity;
	/** Drives the narrow list's secondary line; unused at table density. */
	sortColumn: DocumentTableColumn;
	onOpenDocument: (row: DocumentTableRow) => void;
	/** Rendered instead of the row body when there is nothing to list. */
	emptyState: ReactNode;
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
					<button
						key={row.path}
						type="button"
						role="row"
						aria-rowindex={density === "table" ? index + 2 : index + 1}
						aria-current={row.isActive ? "true" : undefined}
						data-document-row-index={index}
						tabIndex={index === tabbableIndex ? 0 : -1}
						title={row.path}
						style={{
							transform: `translateY(${index * rowHeight}px)`,
							blockSize: rowHeight,
						}}
						className={cn(
							"absolute start-1 end-1 top-0 flex flex-col justify-center rounded-[var(--radius-row)] text-start text-sidebar-foreground outline-hidden",
							"[padding-inline:var(--row-pad-inline)]",
							"transition-[transform,background-color,color] duration-180 ease-snappy motion-reduce:transition-none",
							"focus-visible:ring-1 focus-visible:ring-ring",
							// `--selected`, not `--sidebar-accent`. `--sidebar-accent` only
							// escalates to the real selection colour inside
							// `[data-sidebar-root]:focus-within`, and this list is deliberately
							// outside the sidebar; worse, all three dark themes define it as
							// `var(--accent)` — byte-identical to the hover background — which
							// left the open document invisible. Hover is withheld from the
							// active row so it cannot wash the selection back out: the two
							// tokens simply differ (light themes make `--accent` lighter than
							// `--selected`, dark themes darker), so an unguarded hover would
							// repaint the open row either way.
							row.isActive
								? "bg-selected text-selected-foreground font-medium"
								: "hover:bg-accent",
						)}
						onClick={() => onOpenDocument(row)}
						onKeyDown={(event) => onRowKeyDown(event, index)}
					>
						{density === "table" ? (
							<span
								role="presentation"
								className={DOCUMENT_TABLE_GRID_TEMPLATE}
							>
								<span
									role="gridcell"
									tabIndex={-1}
									className="min-w-0 truncate text-[length:var(--font-size-sidebar)]"
								>
									{row.name}
								</span>
								<span
									role="gridcell"
									tabIndex={-1}
									className={secondaryTextClass(row.isActive)}
								>
									{row.folderLabel}
								</span>
								<span
									role="gridcell"
									tabIndex={-1}
									className={cn(
										secondaryTextClass(row.isActive),
										"tabular-nums",
									)}
									title={formatModifiedAtTitle(row.modifiedAt)}
								>
									{formatModifiedAt(row.modifiedAt)}
								</span>
							</span>
						) : (
							<span
								role="gridcell"
								tabIndex={-1}
								className="flex min-w-0 flex-col"
							>
								<span className="min-w-0 truncate text-[length:var(--font-size-sidebar)]">
									{row.name}
								</span>
								<span
									className={cn(
										secondaryTextClass(row.isActive),
										sortColumn === "modified" && "tabular-nums",
									)}
								>
									{secondaryLabel(row, sortColumn)}
								</span>
							</span>
						)}
					</button>
				))}
			</div>
		</div>
	);
}
