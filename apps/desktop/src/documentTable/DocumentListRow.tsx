import {
	COMPACT_GAP_VAR,
	formatRevisionTime,
	rowDate,
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
import { FolderChip, lastFolderName } from "./FolderChip";
import { MiddleTruncatedPath } from "./MiddleTruncatedPath";
import type { NavDensityTier } from "./navDensity";
import {
	formatPropertyValue,
	type PropertyFieldId,
} from "./properties/propertyFields";

/**
 * Full-table density: the same 28px rhythm the sidebar uses, so the two lists
 * read as one app.
 */
export const DOCUMENT_TABLE_ROW_HEIGHT = SIDEBAR_VIRTUAL_ROW_HEIGHT;
/**
 * Rail-tier density (title only, no secondary line): one text line, so it takes
 * the app's compact single-line rhythm rather than a roomy row the title cannot
 * fill.
 */
export const DOCUMENT_LIST_ROW_HEIGHT = 32;
/**
 * List-tier density (260–399px): title plus the 2nd info on a single clamped
 * line. Two lines, so it matches the card tier's height — the narrow tier must
 * not be TALLER than the wider one above it, and a short meta must not leave
 * dead space.
 */
export const DOCUMENT_CARD_ROW_HEIGHT = 56;
/**
 * Card-tier density (400–559px): title row (dates on its right) plus one
 * truncated detail line — two single lines.
 */
export const DOCUMENT_CARD_TIER_ROW_HEIGHT = 56;
/**
 * Table-tier density (560px+ of list width): the card layout with room for a
 * second detail line, so widening keeps revealing more info.
 */
export const DOCUMENT_NARROW_TABLE_ROW_HEIGHT = 64;

/**
 * Shared by the header row and the body rows so the two grids cannot drift.
 * Written as a literal (not composed at runtime) because Tailwind only emits
 * classes it can see in the source text.
 */
export const DOCUMENT_TABLE_GRID_TEMPLATE =
	"grid grid-cols-[minmax(0,1fr)_minmax(0,11rem)_minmax(0,10rem)_minmax(0,10rem)] items-center gap-2";

export type DocumentRowDensity = "table" | "list";

/**
 * Uniform row height for the virtualizer. The full-width table is always one
 * line; the narrow list grows with the density tier so the card meta never
 * overflows its row — the virtualizer needs one number per tier, so the meta
 * block is line-clamped to match (1 line on list, 2 on card, 3 on table).
 * Rail keeps the compact title-only height.
 */
export function documentRowHeight(
	density: DocumentRowDensity,
	navTier: NavDensityTier = "list",
): number {
	if (density === "table") return DOCUMENT_TABLE_ROW_HEIGHT;
	if (navTier === "rail") return DOCUMENT_LIST_ROW_HEIGHT;
	if (navTier === "table") return DOCUMENT_NARROW_TABLE_ROW_HEIGHT;
	if (navTier === "card") return DOCUMENT_CARD_TIER_ROW_HEIGHT;
	return DOCUMENT_CARD_ROW_HEIGHT;
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
 * Card-tier date beside the title: always "27 Aug" (day first, regardless of
 * locale order), plus the year only when it is not the current one.
 */
export function formatCardDate(seconds: number, now = new Date()): string {
	const at = new Date(seconds * 1000);
	if (Number.isNaN(at.getTime())) return "";
	const month = at.toLocaleString("en-GB", { month: "short" });
	const dayMonth = `${at.getDate()} ${month}`;
	return at.getFullYear() === now.getFullYear()
		? dayMonth
		: `${dayMonth} ${at.getFullYear()}`;
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
	/**
	 * Peek-list density tier. Only read at `list` density: every tier that
	 * shows the 2nd info wraps it into a meta block — one line on list, two on
	 * card, three on table. Defaults to `list`.
	 */
	navTier?: NavDensityTier;
	/** Data columns in the live order (Name excluded); drives the card meta. */
	metaColumns?: DocumentTableColumn[];
	/** Front-matter tags when the tag scan has them; appended to the card meta. */
	tags?: readonly string[];
	/**
	 * A10: extra start inset in rem so a document under a group header lines up
	 * with its hierarchy. Zero in the ungrouped list, so the flat view is
	 * byte-for-byte unchanged.
	 */
	indentRem?: number;
	/** Right-click opens the host-wired row menu. Absent means no menu. */
	onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
	/** Front-matter property cells after the built-in ones; full table only. */
	propertyColumns?: readonly PropertyFieldId[];
	/** Live sort column; picks which date a card row shows. */
	sortColumn?: string;
	/**
	 * A hover "⋮" menu overlays the row's end edge (DocumentRowList). Card rows
	 * then reserve that gutter so the date never sits under the trigger.
	 */
	hasMenu?: boolean;
};

function PropertyCell({
	fieldId,
	row,
}: {
	fieldId: PropertyFieldId;
	row: DocumentTableRow;
}) {
	const text = formatPropertyValue(row.properties?.[fieldId], fieldId);
	return (
		<span
			role="gridcell"
			tabIndex={-1}
			data-property-cell={fieldId}
			className={cn(secondaryTextClass(row.isActive), "tabular-nums")}
			title={text || undefined}
		>
			{text}
		</span>
	);
}

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
				data-flip-id={flipId(row, column)}
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
				data-flip-id={flipId(row, column)}
				className={secondaryTextClass(isActive)}
			>
				<MiddleTruncatedPath
					path={row.folderLabel}
					className="block truncate"
				/>
			</span>
		);
	}
	return (
		<span
			role="gridcell"
			tabIndex={-1}
			data-flip-id={flipId(row, "name")}
			title={row.path}
			className="min-w-0 truncate text-[length:var(--font-size-sidebar)]"
		>
			{row.name}
		</span>
	);
}

/**
 * Stable FLIP id for one cell: the same id in the stacked list and the grid,
 * so the kit's FLIP glides it from one layout to the other.
 */
function flipId(row: DocumentTableRow, column: DocumentTableColumn): string {
	return `${row.path}::${column}`;
}

/**
 * The stacked secondary line's lead-in, from the kit's compact-gap CSS var:
 * it widens smoothly as the list nears the grid breakpoint, written straight
 * from a ResizeObserver so dragging re-renders nothing.
 */
const COMPACT_GAP_STYLE: CSSProperties = {
	marginInlineStart: `var(${COMPACT_GAP_VAR}, 0px)`,
};

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
		isActive ? "text-selected-foreground" : "text-muted-foreground/70",
	);
}

function tagText(tags: readonly string[] | undefined): string {
	return (tags ?? [])
		.map((tag) => tag.trim())
		.filter((tag) => tag.length > 0)
		.map((tag) => `#${tag}`)
		.join(" ");
}

/**
 * Card tier (400–559px): short details (dates) sit right of the title, faded
 * and tabular; long details (folder, tags) get one truncated line below. Each
 * date keeps its column's flip id so it glides between layouts.
 */
function CardTierCell({
	row,
	metaColumns,
	tags,
	sortColumn,
}: {
	row: DocumentTableRow;
	metaColumns: DocumentTableColumn[];
	tags: readonly string[] | undefined;
	sortColumn: string | undefined;
}) {
	const date = cardDate(row, sortColumn);
	const showFolder =
		metaColumns.includes("folder") && lastFolderName(row.folderLabel) !== "";
	const tagLabel = tagText(tags);
	const faded = row.isActive
		? "text-selected-foreground"
		: "text-muted-foreground/70";
	return (
		<span role="gridcell" tabIndex={-1} className="flex min-w-0 flex-col gap-1">
			<span className="flex min-w-0 items-baseline gap-3">
				<span
					data-flip-id={flipId(row, "name")}
					title={row.path}
					className="min-w-0 flex-1 truncate text-[length:var(--font-size-sidebar)]"
				>
					{row.name}
				</span>
				{date.label ? (
					<span
						data-card-date={date.field}
						data-flip-id={flipId(row, date.field)}
						title={date.title}
						className={cn(
							"shrink-0 whitespace-nowrap text-end text-[12px] font-normal tabular-nums",
							faded,
						)}
					>
						{date.label}
					</span>
				) : null}
			</span>
			{showFolder || tagLabel ? (
				<span
					data-card-details=""
					className={cn(
						"flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px]",
						faded,
					)}
				>
					{showFolder ? (
						<span
							data-flip-id={flipId(row, "folder")}
							className="flex min-w-0 shrink items-center overflow-hidden"
						>
							<FolderChip folderLabel={row.folderLabel} />
						</span>
					) : null}
					{tagLabel
						? tagLabel.split(" ").map((tag) => (
								<span
									key={tag}
									title={tagLabel}
									className="mdly-chip shrink-0 [block-size:18px] [font-size:11px] [padding-inline:6px]"
								>
									{tag}
								</span>
							))
						: null}
				</span>
			) : null}
		</span>
	);
}

/**
 * The one date a card row shows: the list's sort field when it is a date
 * column (created/modified), modified otherwise. The tooltip names both with
 * full datetimes. Row timestamps are seconds; the kit takes milliseconds.
 */
export function cardDate(
	row: Pick<DocumentTableRow, "modifiedAt" | "createdAt">,
	sortColumn: string | undefined,
	now = new Date(),
) {
	return rowDate(row.modifiedAt * 1000, row.createdAt * 1000, sortColumn, now);
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
	navTier: _navTier = "list",
	metaColumns,
	tags,
	indentRem = 0,
	onContextMenu,
	propertyColumns = [],
	sortColumn,
	hasMenu = false,
}: DocumentListRowProps) {
	// Every list-density row that shows the 2nd info is a stacked card — title
	// plus one meta block wrapping every data column (and tags), clamped to
	// the lines the tier's fixed row height fits. Rail hides the secondary, so
	// it stays title-only; the full-width table never takes this branch, so
	// its grid is untouched by construction.
	const isCard = density === "list" && !hideSecondary;
	return (
		<button
			key={row.path}
			type="button"
			role="row"
			aria-rowindex={density === "table" ? index + 2 : index + 1}
			aria-current={row.isActive ? "true" : undefined}
			data-document-row-index={index}
			tabIndex={index === tabbableIndex ? 0 : -1}
			style={{
				transform: `translateY(${index * rowHeight}px)`,
				blockSize: rowHeight,
				// Group view only: keep the row's own start padding and add the
				// hierarchy inset on top, exactly as DocumentGroupHeader does
				// (its outer div carries the indent, its button the padding).
				...(indentRem > 0
					? {
							paddingInlineStart: `calc(var(--row-pad-inline) + ${indentRem}rem)`,
						}
					: null),
			}}
			className={cn(
				"absolute start-1 end-1 [inset-block-start:0] flex flex-col justify-center rounded-mdly-control text-start text-sidebar-foreground outline-hidden",
				"[padding-inline:var(--row-pad-inline)]",
				isCard && "[padding-block:8px]",
				isCard &&
					hasMenu &&
					"[padding-inline-end:calc(var(--row-pad-inline)+1.375rem)]",
				"transition-[transform,background-color,color] duration-180 ease-snappy motion-reduce:transition-none [[data-resizing]_&]:transition-none",
				"focus-visible:ring-[3px] focus-visible:ring-mdly-ink/20",
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
					{propertyColumns.map((fieldId) => (
						<PropertyCell key={fieldId} fieldId={fieldId} row={row} />
					))}
				</span>
			) : hideSecondary ? (
				<span role="gridcell" tabIndex={-1} className="flex min-w-0 flex-col">
					<span
						data-flip-id={flipId(row, "name")}
						title={row.path}
						className="min-w-0 truncate text-[length:var(--font-size-sidebar)]"
					>
						{row.name}
					</span>
				</span>
			) : isCard ? (
				<CardTierCell
					row={row}
					metaColumns={
						metaColumns ?? columns.filter((column) => column !== "name")
					}
					tags={tags}
					sortColumn={sortColumn}
				/>
			) : (
				<span role="gridcell" tabIndex={-1} className="flex min-w-0 flex-col">
					<span
						data-flip-id={flipId(row, "name")}
						title={row.path}
						className="min-w-0 truncate text-[length:var(--font-size-sidebar)]"
					>
						{row.name}
					</span>
					<span
						data-flip-id={flipId(row, secondaryColumn)}
						style={COMPACT_GAP_STYLE}
						className={cn(
							secondaryTextClass(row.isActive),
							(secondaryColumn === "modified" ||
								secondaryColumn === "created") &&
								"tabular-nums",
						)}
					>
						{secondaryColumn === "folder" ? (
							<MiddleTruncatedPath
								path={row.folderLabel}
								className="block truncate"
							/>
						) : (
							secondaryLabel(row, secondaryColumn)
						)}
					</span>
				</span>
			)}
		</button>
	);
}
