import { Button } from "@hubble.md/ui";
import type { RefObject } from "react";
import MingcuteArrowLeftLine from "~icons/mingcute/arrow-left-line";
import { DocumentFilterInput } from "./DocumentFilterInput";
import { DocumentRowList } from "./DocumentRowList";
import type { DocumentListingState } from "./documentListingState";
import type { DocumentTableRow, DocumentTableView } from "./documentTableView";
import { NavFooterStrip } from "./NavFooterStrip";
import { NavListHeader } from "./NavListHeader";
import { columnsForTier, type NavDensityTier } from "./navDensity";
import { PEEK_LIST_DEFAULT_WIDTH } from "./peekListWidth";
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
};

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
}: {
	listing: DocumentListingState;
	filter: string;
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

	return (
		<p className={NARROW_MESSAGE_CLASS}>
			{filter.length > 0
				? "No documents match this filter."
				: "No documents in this workspace yet."}
		</p>
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
}: DocumentNarrowListProps) {
	// R9: Rail shows the title only; every wider tier keeps the secondary line.
	const showSecondary = columnsForTier(navTier).length > 1;
	return (
		<div
			ref={listRef}
			data-nav-tier={navTier}
			className="flex shrink-0 flex-col border-e border-sidebar-border bg-sidebar"
			style={{ inlineSize: listInlineSize }}
		>
			<header
				className={`flex shrink-0 flex-col gap-1 px-2 [padding-block-end:0.25rem] ${WINDOW_CHROME_INSET_CLASS}`}
			>
				<button
					type="button"
					className="flex h-8 w-full items-center gap-1.5 rounded-[var(--radius-row)] [padding-inline:var(--row-pad-inline)] text-start text-[length:var(--font-size-sidebar)] text-muted-foreground outline-hidden transition-[background-color,color] duration-150 ease-snappy hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none"
					onClick={onShowAllDocuments}
				>
					<MingcuteArrowLeftLine aria-hidden="true" className="size-3.5" />
					<span className="min-w-0 truncate">All documents</span>
				</button>
				<DocumentFilterInput value={view.filter} onChange={onFilterChange} />
			</header>
			<div
				role="grid"
				aria-label="Documents"
				aria-rowcount={rows.length}
				className="flex min-h-0 flex-1 flex-col px-1 pb-2"
			>
				<NavListHeader navTier={navTier} />
				<DocumentRowList
					rows={rows}
					density="list"
					hideSecondary={!showSecondary}
					view={view}
					onOpenDocument={onOpenDocument}
					emptyState={
						<div className="p-2">
							<NarrowListEmptyState
								listing={listing}
								filter={view.filter}
								onRetryListing={onRetryListing}
							/>
						</div>
					}
				/>
				<NavFooterStrip />
			</div>
		</div>
	);
}
