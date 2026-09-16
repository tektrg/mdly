import { Button } from "@hubble.md/ui";
import MingcuteArrowLeftLine from "~icons/mingcute/arrow-left-line";
import { DocumentFilterInput } from "./DocumentFilterInput";
import { DocumentRowList } from "./DocumentRowList";
import type { DocumentListingState } from "./documentListingState";
import type { DocumentTableRow, DocumentTableView } from "./documentTableView";
import { WINDOW_CHROME_INSET_CLASS } from "./windowChromeInset";

export type DocumentNarrowListProps = {
	rows: DocumentTableRow[];
	view: DocumentTableView;
	listing: DocumentListingState;
	onOpenDocument: (row: DocumentTableRow) => void;
	onFilterChange: (filter: string) => void;
	onShowAllDocuments: () => void;
	onRetryListing: () => void;
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
 * The table after a document takes the stage. Fixed `w-64` — this codebase has
 * no resizable-split primitive, and inventing one is out of phase-1 scope.
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
}: DocumentNarrowListProps) {
	return (
		<div className="flex w-64 shrink-0 flex-col border-e border-sidebar-border bg-sidebar">
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
				<DocumentRowList
					rows={rows}
					density="list"
					sortColumn={view.sort.column}
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
			</div>
		</div>
	);
}
