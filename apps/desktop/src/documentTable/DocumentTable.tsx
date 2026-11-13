import { Button } from "@hubble.md/ui";
import {
	type ComponentProps,
	type HTMLAttributes,
	type ReactNode,
	useRef,
	useState,
} from "react";
import MingcuteArrowUpLine from "~icons/mingcute/arrow-up-line";
import MingcuteHistoryLine from "~icons/mingcute/history-line";
import MingcuteLoading3Line from "~icons/mingcute/loading-3-line";
import { cn } from "../lib/utils";
import { ColumnResizeHandle } from "./ColumnResizeHandle";
import { DocumentFilterInput } from "./DocumentFilterInput";
import {
	DOCUMENT_TABLE_GRID_TEMPLATE,
	DocumentRowList,
} from "./DocumentRowList";
import type { DocumentRowListMenu } from "./DocumentRowMenu";
import type { DocumentListingState } from "./documentListingState";
import {
	type DocumentTableLayoutColumn,
	moveDocumentTableColumn,
	resetDocumentTableColumnWidth,
	resetDocumentTableLayout,
	setDocumentTableColumnWidth,
	useDocumentTableLayout,
} from "./documentTableLayout";
import { movePropertyColumn } from "./documentTableStore";
import type {
	DocumentTableColumn,
	DocumentTableRow,
	DocumentTableSortColumn,
	DocumentTableView,
} from "./documentTableView";
import { NavFooterStrip } from "./NavFooterStrip";
import { NavListHeader } from "./NavListHeader";
import { addColumnMenuFields } from "./properties/builtinFields";
import {
	AddPropertyColumnItems,
	AddPropertyColumnMenu,
	PropertyColumnMenu,
} from "./properties/PropertyControls";
import {
	PropertyMenu,
	PropertyMenuItem,
	PropertyMenuSeparator,
	PropertySubmenu,
} from "./properties/PropertyMenu";
import { PropertyViewBar, SaveViewButton } from "./properties/PropertyViewBar";
import {
	fallbackPropertyLabel,
	type PropertyField,
	type PropertyFieldId,
} from "./properties/propertyFields";
import {
	usePropertyScanState,
	usePropertyScanStatus,
} from "./properties/usePropertyModel";
import { SavedViewsBanner } from "./SavedViewsBanner";
import {
	useCurrentDocumentView,
	useWorkspaceFolderPaths,
} from "./useDocumentTableRows";
import { DocumentBoard } from "./views/DocumentBoard";
import { DocumentCalendar } from "./views/DocumentCalendar";
import { ViewTypeSwitcher } from "./views/ViewTypeSwitcher";
import { WINDOW_CHROME_INSET_CLASS } from "./windowChromeInset";

export const COLUMN_LABELS: Record<DocumentTableColumn, string> = {
	name: "Name",
	folder: "Folder",
	modified: "Modified",
	created: "Created",
};

/**
 * Header display only: "tags" -> "Tags", "due_date" -> "Due_Date". The field id
 * and stored label are untouched.
 */
export function titleCaseLabel(label: string): string {
	return label.replace(
		/(^|[\s_\-/])(\p{Ll})/gu,
		(_match, separator: string, letter: string) =>
			separator + letter.toUpperCase(),
	);
}

function ariaSortFor(
	view: DocumentTableView,
	column: DocumentTableSortColumn,
): "ascending" | "descending" | "none" {
	if (view.sort.column !== column) return "none";
	return view.sort.direction === "asc" ? "ascending" : "descending";
}

/** Fixed trailing gutter: the header's "+" cell, mirrored by the body. */
const TRAILING_CELL_CLASS = "w-7 shrink-0";

const SORT_ARROW_CLASS =
	"size-3 shrink-0 transition-[transform,opacity] duration-180 ease-snappy motion-reduce:transition-none";
const HEADER_BUTTON_CLASS =
	"group/sort flex h-8 w-full items-center gap-1 rounded-mdly-control text-start text-[11px] font-medium text-muted-foreground outline-hidden transition-colors duration-150 ease-snappy hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-mdly-ink/20 motion-reduce:transition-none";

/** A front-matter property column header: sort on click (unless multi-value), menu, resize. */
function PropertyColumnHeader({
	fieldId,
	field,
	view,
	onToggleSort,
	resizeHandle,
	reorder,
}: {
	fieldId: PropertyFieldId;
	field: PropertyField | undefined;
	view: DocumentTableView;
	onToggleSort: (column: DocumentTableSortColumn) => void;
	resizeHandle: ReactNode;
	/** Drag + Alt+Arrow wiring; property columns reorder among themselves. */
	reorder: {
		isSource: boolean;
		isTarget: boolean;
		dragProps: Pick<
			HTMLAttributes<HTMLDivElement>,
			"onDragStart" | "onDragOver" | "onDrop" | "onDragEnd"
		>;
		onMove: (delta: -1 | 1) => void;
	};
}) {
	const label = titleCaseLabel(field?.label ?? fallbackPropertyLabel(fieldId));
	const sortable = field !== undefined && field.type !== "multiSelect";
	const isSorted = view.sort.column === fieldId;
	return (
		<div
			role="columnheader"
			tabIndex={-1}
			aria-sort={ariaSortFor(view, fieldId)}
			draggable
			{...reorder.dragProps}
			className={cn(
				"group relative flex min-w-0 cursor-grab select-none items-center",
				reorder.isSource && "opacity-40",
				reorder.isTarget && "bg-accent",
			)}
		>
			<button
				type="button"
				className={cn(HEADER_BUTTON_CLASS, "min-w-0 flex-1")}
				onClick={() => (sortable ? onToggleSort(fieldId) : undefined)}
				onKeyDown={(event) => {
					if (!event.altKey) return;
					if (event.key === "ArrowLeft") {
						event.preventDefault();
						reorder.onMove(-1);
					} else if (event.key === "ArrowRight") {
						event.preventDefault();
						reorder.onMove(1);
					}
				}}
				title={`${
					sortable ? `Sort by ${label}.` : `${label} (tags cannot be sorted).`
				} Drag to reorder (Alt+←/→ to move).`}
			>
				<span
					aria-hidden="true"
					data-drag-handle
					className="shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-40 group-focus-within:opacity-40 motion-reduce:transition-none"
				>
					⠿
				</span>
				<span className="min-w-0 truncate">{label}</span>
				{sortable ? (
					<MingcuteArrowUpLine
						aria-hidden="true"
						className={cn(
							SORT_ARROW_CLASS,
							isSorted
								? "text-mdly-ink opacity-100"
								: "opacity-0 group-hover/sort:opacity-40 group-focus-visible/sort:opacity-40",
							(isSorted ? view.sort.direction : "asc") === "desc" &&
								"rotate-180",
						)}
					/>
				) : null}
			</button>
			<PropertyColumnMenu
				fieldId={fieldId}
				field={field}
				label={label}
				view={view}
			/>
			{resizeHandle}
		</div>
	);
}

function DocumentTableHeader({
	view,
	onToggleSort,
	propertyFields,
	trailing,
}: {
	view: DocumentTableView;
	onToggleSort: (column: DocumentTableSortColumn) => void;
	propertyFields: readonly PropertyField[];
	/** The header row's trailing "+" (add a property column). */
	trailing?: ReactNode;
}) {
	const { columns, gridStyle, propertyColumns } = useDocumentTableLayout();
	const [dragSourceIndex, setDragSourceIndex] = useState<number | null>(null);
	const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
	// Separate from the built-in drag: the two groups never accept each other's drops.
	const [propDragIndex, setPropDragIndex] = useState<number | null>(null);
	const [propDropIndex, setPropDropIndex] = useState<number | null>(null);
	const endPropDrag = () => {
		setPropDragIndex(null);
		setPropDropIndex(null);
	};
	const resizeDragRef = useRef<{
		column: DocumentTableLayoutColumn;
		startX: number;
		startWidth: number;
	} | null>(null);
	const resizeHandleFor = (column: DocumentTableLayoutColumn) => (
		<ColumnResizeHandle
			onResizeStart={(clientX, startWidth) => {
				resizeDragRef.current = { column, startX: clientX, startWidth };
			}}
			onResizeMove={(clientX) => {
				const drag = resizeDragRef.current;
				if (!drag) return;
				setDocumentTableColumnWidth(
					drag.column,
					drag.startWidth + (clientX - drag.startX),
				);
			}}
			onResizeEnd={() => {
				resizeDragRef.current = null;
			}}
			onReset={() => resetDocumentTableColumnWidth(column)}
		/>
	);

	return (
		<div role="rowgroup" className="flex shrink-0 border-b border-mdly-line">
			<div
				role="row"
				aria-rowindex={1}
				tabIndex={-1}
				style={gridStyle}
				className={cn(
					DOCUMENT_TABLE_GRID_TEMPLATE,
					"mx-1 min-w-0 flex-1 [padding-inline:var(--row-pad-inline)]",
				)}
			>
				{columns.map((column, index) => {
					const isSorted = view.sort.column === column;
					// Name is pinned first: draggable only past index 0.
					const draggable = index > 0;
					return (
						<div
							key={column}
							role="columnheader"
							tabIndex={-1}
							aria-sort={ariaSortFor(view, column)}
							draggable={draggable}
							onDragStart={(event) => {
								if (!draggable) return;
								if (
									(event.target as HTMLElement | null)?.closest?.(
										"[data-resize-handle]",
									)
								) {
									event.preventDefault();
									return;
								}
								setDragSourceIndex(index);
								setDropTargetIndex(null);
								event.dataTransfer.effectAllowed = "move";
								event.dataTransfer.setData("text/plain", column);
							}}
							onDragOver={(event) => {
								if (!draggable || dragSourceIndex === null) return;
								event.preventDefault();
								event.dataTransfer.dropEffect = "move";
								if (index !== dragSourceIndex) {
									setDropTargetIndex(index);
								}
							}}
							onDrop={(event) => {
								if (!draggable) return;
								event.preventDefault();
								if (dragSourceIndex !== null) {
									moveDocumentTableColumn(dragSourceIndex, index);
								}
								setDragSourceIndex(null);
								setDropTargetIndex(null);
							}}
							onDragEnd={() => {
								setDragSourceIndex(null);
								setDropTargetIndex(null);
							}}
							className={cn(
								"group relative min-w-0",
								draggable && "cursor-grab select-none",
								dragSourceIndex === index && "opacity-40",
								dropTargetIndex === index && "bg-accent",
							)}
						>
							<button
								type="button"
								className={HEADER_BUTTON_CLASS}
								onClick={() => onToggleSort(column)}
								onKeyDown={(event) => {
									if (!event.altKey || !draggable) return;
									if (event.key === "ArrowLeft") {
										event.preventDefault();
										moveDocumentTableColumn(index, index - 1);
									} else if (event.key === "ArrowRight") {
										event.preventDefault();
										moveDocumentTableColumn(index, index + 1);
									}
								}}
								title={
									draggable
										? "Sort. Drag to reorder (Alt+←/→ to move)."
										: "Sort."
								}
							>
								{draggable ? (
									<span
										aria-hidden="true"
										data-drag-handle
										className="shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-40 group-focus-within:opacity-40 motion-reduce:transition-none"
									>
										⠿
									</span>
								) : null}
								{column === "modified" ? (
									<MingcuteHistoryLine
										aria-hidden="true"
										className="size-3 shrink-0"
									/>
								) : null}
								<span className="min-w-0 truncate">
									{COLUMN_LABELS[column]}
								</span>
								<MingcuteArrowUpLine
									aria-hidden="true"
									className={cn(
										"size-3 shrink-0 transition-[transform,opacity] duration-180 ease-snappy motion-reduce:transition-none",
										isSorted
											? "text-mdly-ink opacity-100"
											: "opacity-0 group-hover/sort:opacity-40 group-focus-visible/sort:opacity-40",
										(isSorted ? view.sort.direction : "asc") === "desc" &&
											"rotate-180",
									)}
								/>
							</button>
							{resizeHandleFor(column)}
						</div>
					);
				})}
				{propertyColumns.map((fieldId, index) => (
					<PropertyColumnHeader
						key={fieldId}
						fieldId={fieldId}
						field={propertyFields.find((field) => field.id === fieldId)}
						view={view}
						onToggleSort={onToggleSort}
						resizeHandle={resizeHandleFor(fieldId)}
						reorder={{
							isSource: propDragIndex === index,
							isTarget: propDropIndex === index,
							onMove: (delta) => movePropertyColumn(index, index + delta),
							dragProps: {
								onDragStart: (event) => {
									if (
										(event.target as HTMLElement | null)?.closest?.(
											"[data-resize-handle]",
										)
									) {
										event.preventDefault();
										return;
									}
									setPropDragIndex(index);
									setPropDropIndex(null);
									event.dataTransfer.effectAllowed = "move";
									event.dataTransfer.setData("text/plain", fieldId);
								},
								onDragOver: (event) => {
									if (propDragIndex === null) return;
									event.preventDefault();
									event.dataTransfer.dropEffect = "move";
									if (index !== propDragIndex) setPropDropIndex(index);
								},
								onDrop: (event) => {
									if (propDragIndex === null) return;
									event.preventDefault();
									movePropertyColumn(propDragIndex, index);
									endPropDrag();
								},
								onDragEnd: endPropDrag,
							},
						}}
					/>
				))}
			</div>
			{/* Its own fixed cell, never over a column; the body reserves the same gutter. */}
			<div
				data-header-add-cell
				className={cn(TRAILING_CELL_CLASS, "flex items-center justify-center")}
			>
				{trailing}
			</div>
		</div>
	);
}

/**
 * R8 again, at the surface: a scan that is still running or that failed must
 * never read as "this workspace has no documents".
 */
function DocumentTableEmptyState({
	listing,
	filter,
	hasPropertyFilters,
	propertiesPending = false,
	onRetryListing,
}: {
	listing: DocumentListingState;
	filter: string;
	hasPropertyFilters: boolean;
	/** Chips are set but the property scan has not finished: not "no match" yet. */
	propertiesPending?: boolean;
	onRetryListing: () => void;
}) {
	if (listing.kind === "scanning") {
		return (
			<p
				aria-busy="true"
				className="m-0 flex items-center gap-2 p-3 text-sm text-muted-foreground"
			>
				<MingcuteLoading3Line
					aria-hidden="true"
					className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
				/>
				Looking for documents in this folder…
			</p>
		);
	}

	if (listing.kind === "failed") {
		return (
			<div className="flex flex-col items-start gap-2 p-3">
				<p className="m-0 text-sm text-destructive">
					This folder could not be read, so its documents are not listed.
				</p>
				<p className="m-0 text-[11px] text-muted-foreground/70">
					{listing.message}
				</p>
				<Button size="sm" variant="outline" onClick={onRetryListing}>
					Try again
				</Button>
			</div>
		);
	}

	if (hasPropertyFilters && propertiesPending) {
		return (
			<p aria-busy="true" className="m-0 p-3 text-sm text-muted-foreground">
				Reading front matter…
			</p>
		);
	}

	return (
		<p className="m-0 p-3 text-sm text-muted-foreground">
			{filter.length > 0 || hasPropertyFilters
				? "No documents match this filter."
				: "No documents in this workspace yet."}
		</p>
	);
}

export type DocumentTableProps = {
	rows: DocumentTableRow[];
	view: DocumentTableView;
	listing: DocumentListingState;
	onOpenDocument: (row: DocumentTableRow) => void;
	onFilterChange: (filter: string) => void;
	onToggleSort: (column: DocumentTableSortColumn) => void;
	onRetryListing: () => void;
	/** Title-column menu; omitted in tests that only exercise the grid. */
	rowMenu?: DocumentRowListMenu;
};

/**
 * The view bar shows scan progress, so it alone subscribes to the whole scan
 * state; the table/board around it don't re-render on every progress tick.
 */
function ScanAwarePropertyViewBar(
	props: Omit<ComponentProps<typeof PropertyViewBar>, "scan">,
) {
	const scan = usePropertyScanState();
	return <PropertyViewBar {...props} scan={scan} />;
}

/** The full-width home surface: every Markdown document in the workspace. */
export function DocumentTable({
	rows,
	view,
	listing,
	onOpenDocument,
	onFilterChange,
	onToggleSort,
	onRetryListing,
	rowMenu,
}: DocumentTableProps) {
	const { isCustomized, propertyColumns } = useDocumentTableLayout();
	const { savedView, propertyFields, layout } = useCurrentDocumentView();
	// Status only: progress ticks re-render just the view bar (below).
	const scanStatus = usePropertyScanStatus();
	const folders = useWorkspaceFolderPaths();
	const isReadingProperties =
		scanStatus === "scanning" || scanStatus === "idle";
	// Saved views write every edit straight into the view (Notion-style), so
	// only the built-in view can hold unsaved changes.
	const hasUnsavedChanges =
		savedView === null &&
		(layout.viewType !== "table" ||
			view.propertyFilters.length > 0 ||
			view.propertyGroupBy !== null ||
			propertyColumns.length > 0);
	const canResetColumns = isCustomized && layout.viewType !== "board";
	const addColumnFields = addColumnMenuFields(
		propertyFields,
		layout.viewType,
		propertyColumns,
	);
	return (
		<section
			data-doc-surface
			className="flex h-full min-h-0 flex-col bg-background"
		>
			<header
				data-document-table-header
				className={cn(
					"shrink-0 px-3",
					// The reserved band reads as the window's title bar, so the
					// header's own space above the title is already accounted for.
					WINDOW_CHROME_INSET_CLASS,
				)}
			>
				<h1 className="sr-only">{savedView?.name ?? "Documents"}</h1>
				<NavListHeader
					variant="tabs"
					hasUnsavedChanges={hasUnsavedChanges}
					trailing={<SaveViewButton variant="add" />}
					end={<SaveViewButton variant="save" visible={hasUnsavedChanges} />}
				/>
			</header>
			<ScanAwarePropertyViewBar
				view={view}
				fields={propertyFields}
				folders={folders}
				leading={<ViewTypeSwitcher value={layout.viewType} />}
				trailing={
					<>
						<DocumentFilterInput
							value={view.filter}
							onChange={onFilterChange}
							className="w-56"
						/>
						<PropertyMenu
							trigger={<span aria-hidden="true">⋯</span>}
							triggerClassName="inline-flex size-7 shrink-0 items-center justify-center rounded-mdly-control text-sm text-muted-foreground outline-hidden hover:bg-mdly-control hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-mdly-ink/20 aria-expanded:bg-mdly-control"
							triggerLabel="More view options"
						>
							<PropertySubmenu label="Add property">
								<AddPropertyColumnItems
									fields={addColumnFields}
									visibleColumns={propertyColumns}
									isScanning={scanStatus === "scanning"}
								/>
							</PropertySubmenu>
							<PropertyMenuSeparator />
							<PropertyMenuItem
								disabled={!canResetColumns}
								onClick={resetDocumentTableLayout}
							>
								Reset columns
							</PropertyMenuItem>
						</PropertyMenu>
					</>
				}
			/>
			<SavedViewsBanner />
			{layout.viewType === "board" ? (
				<DocumentBoard
					rows={rows}
					fields={propertyFields}
					boardField={layout.boardField}
					boardSettings={layout.board}
					propertyColumns={propertyColumns}
					rowMenu={rowMenu}
					isReadingProperties={isReadingProperties}
					onOpenDocument={onOpenDocument}
				/>
			) : layout.viewType === "calendar" ? (
				<DocumentCalendar
					rows={rows}
					fields={propertyFields}
					calendarField={layout.calendarField}
					isReadingProperties={isReadingProperties}
					onOpenDocument={onOpenDocument}
				/>
			) : (
				<div
					role="grid"
					aria-label="Documents"
					aria-rowcount={rows.length + 1}
					className="flex min-h-0 flex-1 flex-col px-2 pb-2"
				>
					<DocumentTableHeader
						view={view}
						onToggleSort={onToggleSort}
						propertyFields={propertyFields}
						trailing={
							<AddPropertyColumnMenu
								fields={addColumnFields}
								visibleColumns={propertyColumns}
								isScanning={scanStatus === "scanning"}
							/>
						}
					/>
					<div className="flex min-h-0 flex-1">
						<div className="flex min-h-0 min-w-0 flex-1 flex-col">
							<DocumentRowList
								rows={rows}
								density="table"
								view={view}
								onOpenDocument={onOpenDocument}
								menu={rowMenu}
								emptyState={
									<DocumentTableEmptyState
										listing={listing}
										filter={view.filter}
										hasPropertyFilters={view.propertyFilters.length > 0}
										propertiesPending={
											scanStatus === "scanning" || scanStatus === "idle"
										}
										onRetryListing={onRetryListing}
									/>
								}
							/>
						</div>
						<div aria-hidden="true" className={TRAILING_CELL_CLASS} />
					</div>
					<NavFooterStrip />
				</div>
			)}
		</section>
	);
}
