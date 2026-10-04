import {
	COMPACT_GAP_VAR,
	formatRevisionTime,
	SIDEBAR_VIRTUAL_ROW_HEIGHT,
} from "@mdly/workspace-kit";
import type {
	CSSProperties,
	KeyboardEvent as ReactKeyboardEvent,
	MouseEvent as ReactMouseEvent,
} from "react";
import { Fragment } from "react";
import { cn } from "../lib/utils";
import type {
	DocumentTableColumn,
	DocumentTableRow,
} from "./documentTableView";
import { MiddleTruncatedPath } from "./MiddleTruncatedPath";
import type { NavDensityTier } from "./navDensity";

/**
 * Full-table density: the same 28px rhythm the sidebar uses, so the two lists
 * read as one app.
 */
export const DOCUMENT_TABLE_ROW_HEIGHT = SIDEBAR_VIRTUAL_ROW_HEIGHT;
/**
 * Rail-tier density (title only, no secondary line). Keeps the old narrow-list
 * rhythm for the narrowest tier.
 */
export const DOCUMENT_LIST_ROW_HEIGHT = 44;
/**
 * Card-tier density: the secondary line becomes a wrapped meta block — every
 * data column plus tags, clamped to two lines — so it needs headroom for the
 * title plus two wrapped lines. The List tier (260–399px) uses this height
 * too: whenever the 2nd info appears, it wraps.
 */
export const DOCUMENT_CARD_ROW_HEIGHT = 62;
/**
 * Card-tier density (400–559px): title row (dates on its right) plus one
 * truncated detail line — two single lines, so it fits tighter than List.
 */
export const DOCUMENT_CARD_TIER_ROW_HEIGHT = 46;
/**
 * Table-tier density (560px+ of list width): same wrapped meta block as the
 * card, but allowed a third line so widening keeps revealing more info.
 */
export const DOCUMENT_NARROW_TABLE_ROW_HEIGHT = 78;

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
 * line; the narrow list grows with the density tier so the wrapped card meta
 * never overflows its row — the virtualizer needs one number per tier, so the
 * meta block is line-clamped to match (2 lines on list/card, 3 on table).
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
	 * shows the 2nd info wraps it into a meta block — two lines on list and
	 * card, three on table. Defaults to `list`.
	 */
	navTier?: NavDensityTier;
	/** Data columns in the live order (Name excluded); drives the card meta. */
	metaColumns?: DocumentTableColumn[];
	/** Front-matter tags when the tag scan has them; appended to the card meta. */
	tags?: readonly string[];
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

/**
 * Card-tier meta: every data column in the live order, plus tags when the tag
 * scan has them — rendered as one wrapping block, not one column. Empty
 * fragments drop out so a missing timestamp never renders a stray separator.
 * The folder item is keyed so the row can middle-truncate it.
 */
function cardMetaItems(
	row: DocumentTableRow,
	metaColumns: DocumentTableColumn[],
	tags: readonly string[] | undefined,
): { key: DocumentTableColumn | "tags"; text: string }[] {
	const items = metaColumns
		.map((column): { key: DocumentTableColumn | "tags"; text: string } => ({
			key: column,
			text:
				column === "modified"
					? formatModifiedAt(row.modifiedAt)
					: column === "created"
						? formatModifiedAt(row.createdAt)
						: column === "folder"
							? row.folderLabel
							: row.name,
		}))
		.filter((item) => item.text.length > 0);
	const tagLabel = tagText(tags);
	if (tagLabel.length > 0) items.push({ key: "tags", text: tagLabel });
	return items;
}

function cardMetaClass(isActive: boolean): string {
	return cn(
		"min-w-0 break-words text-[11px]",
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
}: {
	row: DocumentTableRow;
	metaColumns: DocumentTableColumn[];
	tags: readonly string[] | undefined;
}) {
	const dateColumns = metaColumns.filter(
		(column) => column === "modified" || column === "created",
	);
	const showFolder = metaColumns.includes("folder") && row.folderLabel !== "";
	const tagLabel = tagText(tags);
	const faded = row.isActive
		? "text-selected-foreground"
		: "text-muted-foreground/70";
	return (
		<span role="gridcell" tabIndex={-1} className="flex min-w-0 flex-col">
			<span className="flex min-w-0 items-baseline gap-2">
				<span
					data-flip-id={flipId(row, "name")}
					className="min-w-0 flex-1 truncate text-[length:var(--font-size-sidebar)]"
				>
					{row.name}
				</span>
				{dateColumns.map((column) => {
					const seconds =
						column === "modified" ? row.modifiedAt : row.createdAt;
					const label = formatCardDate(seconds);
					if (!label) return null;
					return (
						<span
							key={column}
							data-card-date={column}
							data-flip-id={flipId(row, column)}
							title={`${column === "modified" ? "Modified" : "Created"} ${formatModifiedAtTitle(seconds)}`}
							className={cn("shrink-0 text-[11px] tabular-nums", faded)}
						>
							{label}
						</span>
					);
				})}
			</span>
			{showFolder || tagLabel ? (
				<span
					data-card-details=""
					className={cn("flex min-w-0 gap-2 text-[11px]", faded)}
				>
					{showFolder ? (
						<span
							data-flip-id={flipId(row, "folder")}
							className="min-w-0 shrink overflow-hidden"
						>
							<MiddleTruncatedPath
								path={row.folderLabel}
								className="block truncate"
							/>
						</span>
					) : null}
					{tagLabel ? (
						<span className="min-w-0 flex-1 truncate">{tagLabel}</span>
					) : null}
				</span>
			) : null}
		</span>
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
	navTier = "list",
	metaColumns,
	tags,
	onContextMenu,
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
					<span
						data-flip-id={flipId(row, "name")}
						className="min-w-0 truncate text-[length:var(--font-size-sidebar)]"
					>
						{row.name}
					</span>
				</span>
			) : isCard && navTier !== "list" ? (
				<CardTierCell
					row={row}
					metaColumns={
						metaColumns ?? columns.filter((column) => column !== "name")
					}
					tags={tags}
				/>
			) : isCard ? (
				<span role="gridcell" tabIndex={-1} className="flex min-w-0 flex-col">
					<span
						data-flip-id={flipId(row, "name")}
						className="min-w-0 truncate text-[length:var(--font-size-sidebar)]"
					>
						{row.name}
					</span>
					<span className={cn(cardMetaClass(row.isActive), "line-clamp-2")}>
						{cardMetaItems(
							row,
							metaColumns ?? columns.filter((column) => column !== "name"),
							tags,
						).map((item, i) => (
							<Fragment key={item.key}>
								{i > 0 && " • "}
								{item.key === "folder" ? (
									<MiddleTruncatedPath
										path={item.text}
										className="inline-block max-w-full truncate align-bottom"
									/>
								) : item.key === "tags" ? (
									item.text
								) : (
									// Same flip id as the card/grid date cell, so it glides.
									<span data-flip-id={flipId(row, item.key)}>{item.text}</span>
								)}
							</Fragment>
						))}
					</span>
				</span>
			) : (
				<span role="gridcell" tabIndex={-1} className="flex min-w-0 flex-col">
					<span
						data-flip-id={flipId(row, "name")}
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
