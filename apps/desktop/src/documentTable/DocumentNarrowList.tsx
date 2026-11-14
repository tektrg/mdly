import { Button } from "@hubble.md/ui";
import { useFlipOnChange, useResponsiveRowLayout } from "@mdly/workspace-kit";
import { type RefObject, useCallback, useRef } from "react";
import MingcuteArrowLeftLine from "~icons/mingcute/arrow-left-line";
import MingcuteHistoryLine from "~icons/mingcute/history-line";
import { cn } from "../lib/utils";
import { DocumentFilterInput } from "./DocumentFilterInput";
import {
	DOCUMENT_TABLE_GRID_TEMPLATE,
	DocumentRowList,
} from "./DocumentRowList";
import type { DocumentRowListMenu } from "./DocumentRowMenu";
import { COLUMN_LABELS } from "./DocumentTable";
import type { DocumentListingState } from "./documentListingState";
import {
	narrowGridStyleFor,
	useDocumentTableLayout,
} from "./documentTableLayout";
import type { DocumentTableRow, DocumentTableView } from "./documentTableView";
import { FilterEmptyMessage } from "./FilterEmptyMessage";
import { NavFooterStrip } from "./NavFooterStrip";
import { NavListHeader } from "./NavListHeader";
import { columnsForTier, type NavDensityTier } from "./navDensity";
import { PEEK_LIST_DEFAULT_WIDTH } from "./peekListWidth";
import { usePropertyScanStatus } from "./properties/usePropertyModel";
import { useCurrentDocumentView } from "./useDocumentTableRows";
import { DocumentBoard } from "./views/DocumentBoard";
import { WINDOW_CHROME_INSET_CLASS } from "./windowChromeInset";

export type DocumentNarrowListProps = {
	rows: DocumentTableRow[];
	view: DocumentTableView;
	listing: DocumentListingState;
	onOpenDocument: (row: DocumentTableRow) => void;
	onFilterChange: (filter: string) => void;
	onShowAllDocuments: () => void;
	onRetryListing: () => void;
	/** Measured by `useNavContainerWidth` in the peek split; drives the tier. */
	listRef?: RefObject<HTMLDivElement | null>;
	/** R9 tier for the measured list width. Defaults to "list" unmeasured. */
	navTier?: NavDensityTier;
	/** Rendered list inline-size; defaults to the pre-resize `w-64`. */
	listInlineSize?: number;
	/** Title menu; omitted in tests that only exercise the list. */
	rowMenu?: DocumentRowListMenu;
};

/**
 * List inline-size at which the peek list's rows switch from the stacked
 * name + secondary layout to one-line grid cells under column labels.
 * Measured from the list's own width, independent of the R9 tier.
 *
 * Must stay REACHABLE: the list can grow only to the split width minus
 * `PEEK_DOCUMENT_MIN_WIDTH` (600). On a 1280px window with the 220px sidebar
 * open that is 460px, so the old 640 could never be crossed on typical
 * windows (1440 topped out at 620) and the switch never played.
 */
export const NARROW_GRID_BREAKPOINT = 440;

/**
 * Column labels over the grid rows. Marked `data-flip-enter` so the kit's
 * FLIP fades it in after the cells start gliding, and ghosts it out on the
 * way back to the stacked list.
 */
function NarrowGridHeader() {
	const { columns } = useDocumentTableLayout();
	return (
		<div role="rowgroup" data-flip-enter="" className="shrink-0">
			<div
				role="row"
				aria-rowindex={1}
				tabIndex={-1}
				style={narrowGridStyleFor(columns)}
				className={cn(
					DOCUMENT_TABLE_GRID_TEMPLATE,
					"mx-1 h-7 [padding-inline:var(--row-pad-inline)]",
				)}
			>
				{columns.map((column) => (
					<div
						key={column}
						role="columnheader"
						tabIndex={-1}
						className="flex min-w-0 items-center gap-1 text-[11px] uppercase text-muted-foreground"
					>
						{column === "modified" ? (
							<MingcuteHistoryLine
								aria-hidden="true"
								className="size-3 shrink-0"
							/>
						) : null}
						<span className="min-w-0 truncate">{COLUMN_LABELS[column]}</span>
					</div>
				))}
			</div>
		</div>
	);
}

const NARROW_MESSAGE_CLASS =
	"m-0 text-[length:var(--font-size-sidebar)] text-muted-foreground";

/**
 * R8's three states, at sidebar width: a scan still running, a scan that failed,
 * and a folder that genuinely holds nothing must stay three different sentences.
 *
 * The failed state carries the same "Try again" the full-width table offers
 * (`DocumentTable.tsx`). Without it, a user with a document open had no way to
 * re-list a folder that blipped short of refocusing the window.
 */
function NarrowListEmptyState({
	listing,
	filter,
	onRetryListing,
	onClearFilter,
}: {
	listing: DocumentListingState;
	filter: string;
	onClearFilter: () => void;
	onRetryListing: () => void;
}) {
	if (listing.kind === "scanning") {
		return <p className={NARROW_MESSAGE_CLASS}>Looking for documents…</p>;
	}

	if (listing.kind === "failed") {
		return (
			<div className="flex flex-col items-start gap-2">
				<p className="m-0 text-[length:var(--font-size-sidebar)] text-destructive">
					This folder could not be read.
				</p>
				<Button size="sm" variant="outline" onClick={onRetryListing}>
					Try again
				</Button>
			</div>
		);
	}

	if (filter.length > 0) {
		return (
			<FilterEmptyMessage
				filter={filter}
				onClearFilter={onClearFilter}
				className={NARROW_MESSAGE_CLASS}
			/>
		);
	}

	return (
		<p className={NARROW_MESSAGE_CLASS}>No documents in this workspace yet.</p>
	);
}

/**
 * The table after a document takes the stage. Resizable through the peek
 * divider — the inline size comes from the clamped desired width, and the R9
 * density tier from the measured list width.
 *
 * Stays mounted and clickable through a slow or failed open (R5): loading and
 * error are states of the document pane next to it, never of this list.
 */
export function DocumentNarrowList({
	rows,
	view,
	listing,
	onOpenDocument,
	onFilterChange,
	onShowAllDocuments,
	onRetryListing,
	listRef,
	navTier = "list",
	listInlineSize = PEEK_LIST_DEFAULT_WIDTH,
	rowMenu,
}: DocumentNarrowListProps) {
	// R9: Rail shows the title only; every tier that shows the 2nd info wraps
	// it — one line on List, two on Card, three on Table — so widening keeps
	// revealing more info.
	const showSecondary = columnsForTier(navTier).length > 1;
	// Own ref for the kit's width watcher; the host's `listRef` still gets
	// the same element for its density measurement.
	const ownRef = useRef<HTMLDivElement | null>(null);
	const setListElement = useCallback(
		(element: HTMLDivElement | null) => {
			ownRef.current = element;
			if (listRef) listRef.current = element;
		},
		[listRef],
	);
	// Re-renders only when the breakpoint is crossed, then FLIPs every cell
	// (by `data-flip-id`) from its stacked spot to its column, and back. Also
	// writes the kit's compact-gap CSS var on every resize, no render.
	const isGrid =
		useResponsiveRowLayout(ownRef, NARROW_GRID_BREAKPOINT) === "table" &&
		showSecondary;
	// Every R9 tier crossing (rail <-> list <-> card <-> table) re-renders the
	// rows anyway; FLIP across it in the same motion as the grid switch.
	useFlipOnChange(ownRef, navTier);
	// A board view stays a board when it collapses beside the open note.
	const { propertyFields, layout, propertyColumns } = useCurrentDocumentView();
	const scanStatus = usePropertyScanStatus();
	const isBoard = layout.viewType === "board";
	return (
		<div
			ref={setListElement}
			data-doc-surface
			data-row-layout={isBoard ? "board" : isGrid ? "grid" : "stacked"}
			data-nav-tier={navTier}
			className="flex shrink-0 flex-col bg-sidebar"
			style={{ inlineSize: listInlineSize }}
		>
			<header
				className={`flex shrink-0 flex-col gap-2 px-3 [padding-block-end:0.5rem] ${WINDOW_CHROME_INSET_CLASS}`}
			>
				<button
					type="button"
					className="flex h-8 w-full items-center gap-1.5 rounded-mdly-control [padding-inline:var(--row-pad-inline)] text-start text-[length:var(--font-size-sidebar)] text-muted-foreground outline-hidden transition-[background-color,color] duration-150 ease-snappy hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-mdly-ink/20 motion-reduce:transition-none"
					onClick={onShowAllDocuments}
				>
					<MingcuteArrowLeftLine aria-hidden="true" className="size-3.5" />
					<span className="min-w-0 truncate">All documents</span>
				</button>
				<DocumentFilterInput value={view.filter} onChange={onFilterChange} />
			</header>
			{isBoard ? (
				<DocumentBoard
					compact
					rows={rows}
					fields={propertyFields}
					boardField={layout.boardField}
					boardSettings={layout.board}
					propertyColumns={propertyColumns}
					rowMenu={rowMenu}
					isReadingProperties={
						scanStatus === "scanning" || scanStatus === "idle"
					}
					onOpenDocument={onOpenDocument}
				/>
			) : (
				<div
					role="grid"
					aria-label="Documents"
					aria-rowcount={isGrid ? rows.length + 1 : rows.length}
					className="flex min-h-0 flex-1 flex-col px-2 pb-2"
				>
					<div className="shrink-0 px-1">
						<NavListHeader navTier={navTier} />
					</div>
					{isGrid ? <NarrowGridHeader /> : null}
					<DocumentRowList
						rows={rows}
						density="list"
						gridCells={isGrid}
						hideSecondary={!showSecondary}
						navTier={navTier}
						view={view}
						onOpenDocument={onOpenDocument}
						menu={rowMenu}
						emptyState={
							<div className="p-2">
								<NarrowListEmptyState
									listing={listing}
									filter={view.filter}
									onClearFilter={() => onFilterChange("")}
									onRetryListing={onRetryListing}
								/>
							</div>
						}
					/>
					<NavFooterStrip />
				</div>
			)}
		</div>
	);
}
