import {
	formatRevisionTime,
	SIDEBAR_VIRTUAL_ROW_HEIGHT,
} from "@mdly/workspace-kit";
import type {
	CSSProperties,
	KeyboardEvent as ReactKeyboardEvent,
	MouseEvent as ReactMouseEvent,
} from "react";
import { cn } from "../lib/utils";
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
	"grid grid-cols-[minmax(0,1fr)_minmax(0,11rem)_minmax(0,10rem)_minmax(0,10rem)] items-center gap-2";

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

/** Created cells share Modified's compact date rendering — one formatter, two columns. */
export const formatCreatedAt = formatModifiedAt;
export const formatCreatedAtTitle = formatModifiedAtTitle;

type DocumentListRowProps = {
	row: DocumentTableRow;
	index: number;
	rowHeight: number;
	density: DocumentRowDensity;
	/** Live column order (Name pinned first); drives table cells. */
	columns: DocumentTableColumn[];
	/** Inline grid override while reordered/resized; undefined keeps the literal. */
	gridStyle: CSSProperties | undefined;
	/** Narrow list's secondary line: first data column in the live order. */
	secondaryColumn: DocumentTableColumn;
	tabbableIndex: number;
	onOpenDocument: (row: DocumentTableRow) => void;
	onRowKeyDown: (event: ReactKeyboardEvent<HTMLElement>, index: number) => void;
	/**
	 * R9 Rail: the narrowest tier shows the title only. Browse never sets this,
	 * so the full-width table is untouched by construction.
	 */
	hideSecondary?: boolean;
	/** Right-click opens the host-wired row menu. Absent means no menu. */
	onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
};

function TableCell({
	column,
	row,
	isActive,
}: {
	column: DocumentTableColumn;
	row: DocumentTableRow;
	isActive: boolean;
}) {
	if (column === "modified" || column === "created") {
		const timestamp = column === "modified" ? row.modifiedAt : row.createdAt;
		return (
			<span
				role="gridcell"
				tabIndex={-1}
				className={cn(secondaryTextClass(isActive), "tabular-nums")}
				title={formatModifiedAtTitle(timestamp)}
			>
				{formatModifiedAt(timestamp)}
			</span>
		);
	}
	if (column === "folder") {
		return (
			<span
				role="gridcell"
				tabIndex={-1}
				className={secondaryTextClass(isActive)}
			>
				{row.folderLabel}
			</span>
		);
	}
	return (
		<span
			role="gridcell"
			tabIndex={-1}
			className="min-w-0 truncate text-[length:var(--font-size-sidebar)]"
		>
			{row.name}
		</span>
	);
}

function secondaryLabel(
	row: DocumentTableRow,
	secondaryColumn: DocumentTableColumn,
): string {
	return secondaryColumn === "modified"
		? formatModifiedAt(row.modifiedAt)
		: secondaryColumn === "created"
			? formatModifiedAt(row.createdAt)
			: secondaryColumn === "folder"
				? row.folderLabel
				: row.name;
}

function secondaryTextClass(isActive: boolean): string {
	return cn(
		"min-w-0 truncate text-[11px]",
		isActive ? "text-selected-foreground" : "text-muted-foreground",
	);
}

export function DocumentListRow({
	row,
	index,
	rowHeight,
	density,
	columns,
	gridStyle,
	secondaryColumn,
	tabbableIndex,
	onOpenDocument,
	onRowKeyDown,
	hideSecondary = false,
	onContextMenu,
}: DocumentListRowProps) {
	return (
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
				"absolute start-1 end-1 [inset-block-start:0] flex flex-col justify-center rounded-[var(--radius-row)] text-start text-sidebar-foreground outline-hidden",
				"[padding-inline:var(--row-pad-inline)]",
				"transition-[transform,background-color,color] duration-180 ease-snappy motion-reduce:transition-none [[data-resizing]_&]:transition-none",
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
			onContextMenu={onContextMenu}
		>
			{density === "table" ? (
				<span
					role="presentation"
					style={gridStyle}
					className={DOCUMENT_TABLE_GRID_TEMPLATE}
				>
					{columns.map((column) => (
						<TableCell
							key={column}
							column={column}
							row={row}
							isActive={row.isActive}
						/>
					))}
				</span>
			) : hideSecondary ? (
				<span role="gridcell" tabIndex={-1} className="flex min-w-0 flex-col">
					<span className="min-w-0 truncate text-[length:var(--font-size-sidebar)]">
						{row.name}
					</span>
				</span>
			) : (
				<span role="gridcell" tabIndex={-1} className="flex min-w-0 flex-col">
					<span className="min-w-0 truncate text-[length:var(--font-size-sidebar)]">
						{row.name}
					</span>
					<span
						className={cn(
							secondaryTextClass(row.isActive),
							(secondaryColumn === "modified" ||
								secondaryColumn === "created") &&
								"tabular-nums",
						)}
					>
						{secondaryLabel(row, secondaryColumn)}
					</span>
				</span>
			)}
		</button>
	);
}
