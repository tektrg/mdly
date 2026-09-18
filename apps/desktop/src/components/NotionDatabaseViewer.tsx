import { Button } from "@hubble.md/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { desktopApi } from "../desktopApi";
import type { NotionDatabaseQueryResult } from "../desktopApi/types";
import { openOrImportNotionPage } from "../fileActions";
import { dirname } from "../lib/filePath";
import type { NotionDatabaseMetadata } from "../notion/notionDatabase";

type NotionDatabaseViewerProps = {
	path: string;
	metadata: NotionDatabaseMetadata;
	refreshToken?: number;
	onScrollContainerChange?: (el: HTMLDivElement | null) => void;
};

type QueryStatus = "loading" | "ready" | "error";

const ROW_COLUMN_KEY = "__row";
const COLUMN_ORDER_STORAGE_PREFIX = "mdly-desktop-db-column-order:";
const COLUMN_WIDTH_STORAGE_PREFIX = "mdly-desktop-db-column-widths:";
const MIN_COLUMN_WIDTH_PX = 80;
const MAX_COLUMN_WIDTH_PX = 640;

/** Pure reorder: move item from one index to another. */
export function moveColumnOrder(
	columns: string[],
	from: number,
	to: number,
): string[] {
	if (from < 0 || to < 0 || from >= columns.length || to >= columns.length) {
		return columns;
	}
	if (from === to) return columns;
	const next = [...columns];
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	return next;
}

/**
 * Merge a saved order with fresh server columns so reorder survives re-query:
 * keep saved positions, append brand-new columns at the end, drop removed ones.
 */
export function applySavedColumnOrder(
	serverColumns: string[],
	savedOrder: string[] | null,
): string[] {
	if (!savedOrder) return serverColumns;
	const serverSet = new Set(serverColumns);
	const keptInSavedOrder = savedOrder.filter((column) => serverSet.has(column));
	const freshColumns = serverColumns.filter(
		(column) => !savedOrder.includes(column),
	);
	return [...keptInSavedOrder, ...freshColumns];
}

/** Pure clamp for resize drags. */
export function clampColumnWidth(widthPx: number): number {
	if (!Number.isFinite(widthPx)) return MIN_COLUMN_WIDTH_PX;
	return Math.min(
		MAX_COLUMN_WIDTH_PX,
		Math.max(MIN_COLUMN_WIDTH_PX, Math.round(widthPx)),
	);
}

function loadSavedColumnOrder(sourceId: string): string[] | null {
	try {
		const raw = localStorage.getItem(
			`${COLUMN_ORDER_STORAGE_PREFIX}${sourceId}`,
		);
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		return parsed.filter((entry): entry is string => typeof entry === "string");
	} catch {
		return null;
	}
}

function saveColumnOrder(sourceId: string, order: string[]) {
	try {
		localStorage.setItem(
			`${COLUMN_ORDER_STORAGE_PREFIX}${sourceId}`,
			JSON.stringify(order),
		);
	} catch {
		// Storage full or unavailable — order still applies for this session.
	}
}

function loadSavedColumnWidths(sourceId: string): Record<string, number> {
	try {
		const raw = localStorage.getItem(
			`${COLUMN_WIDTH_STORAGE_PREFIX}${sourceId}`,
		);
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return {};
		}
		const widths: Record<string, number> = {};
		for (const [key, value] of Object.entries(
			parsed as Record<string, unknown>,
		)) {
			if (typeof value === "number") widths[key] = clampColumnWidth(value);
		}
		return widths;
	} catch {
		return {};
	}
}

function saveColumnWidths(sourceId: string, widths: Record<string, number>) {
	try {
		localStorage.setItem(
			`${COLUMN_WIDTH_STORAGE_PREFIX}${sourceId}`,
			JSON.stringify(widths),
		);
	} catch {
		// Storage full or unavailable — widths still apply for this session.
	}
}

/**
 * Right-edge handle for resizing one table column.
 * Double-click resets that column to automatic width.
 */
function ColumnResizeHandle({
	onResizeStart,
	onResizeMove,
	onResizeEnd,
	onReset,
}: {
	onResizeStart: (clientX: number, startWidth: number) => void;
	onResizeMove: (clientX: number) => void;
	onResizeEnd: () => void;
	onReset: () => void;
}) {
	return (
		<span
			data-resize-handle
			title="Drag to resize (double-click resets)"
			aria-hidden="true"
			onPointerDown={(event) => {
				if (event.button !== 0) return;
				event.preventDefault();
				event.currentTarget.setPointerCapture(event.pointerId);
				onResizeStart(
					event.clientX,
					event.currentTarget.parentElement?.offsetWidth ?? MIN_COLUMN_WIDTH_PX,
				);
			}}
			onPointerMove={(event) => {
				if (event.buttons > 0) onResizeMove(event.clientX);
			}}
			onPointerUp={() => onResizeEnd()}
			onPointerCancel={() => onResizeEnd()}
			onDoubleClick={(event) => {
				event.stopPropagation();
				onReset();
			}}
			className="absolute inset-y-0 end-0 w-3 cursor-col-resize touch-none"
		>
			<span
				aria-hidden="true"
				className="absolute inset-y-1 end-0.5 w-px bg-primary opacity-0 group-hover:opacity-100"
			/>
		</span>
	);
}

export function NotionDatabaseViewer({
	path,
	metadata,
	refreshToken = 0,
	onScrollContainerChange,
}: NotionDatabaseViewerProps) {
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
	const [query, setQuery] = useState<NotionDatabaseQueryResult | null>(null);
	const [status, setStatus] = useState<QueryStatus>("loading");
	const [error, setError] = useState<string | null>(null);
	const currentCursor = cursorStack[cursorStack.length - 1] ?? null;
	const serverColumns = useMemo(() => query?.columns ?? [], [query]);
	const [savedColumnOrder, setSavedColumnOrder] = useState<string[] | null>(
		() => loadSavedColumnOrder(metadata.sourceId),
	);
	const [savedColumnWidths, setSavedColumnWidths] = useState<
		Record<string, number>
	>(() => loadSavedColumnWidths(metadata.sourceId));
	const [dragSourceIndex, setDragSourceIndex] = useState<number | null>(null);
	const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
	const resizeDragRef = useRef<{
		key: string;
		startX: number;
		startWidth: number;
	} | null>(null);
	const columns = useMemo(
		() => applySavedColumnOrder(serverColumns, savedColumnOrder),
		[serverColumns, savedColumnOrder],
	);
	const hasCustomWidths = Object.keys(savedColumnWidths).length > 0;
	const isCustomized =
		hasCustomWidths || columns.join("|") !== serverColumns.join("|");
	const detailFolderPath = dirname(path) ?? path;

	// Reload the saved layout when switching databases, so each database
	// keeps its own column order and widths.
	useEffect(() => {
		setSavedColumnOrder(loadSavedColumnOrder(metadata.sourceId));
		setSavedColumnWidths(loadSavedColumnWidths(metadata.sourceId));
		setDragSourceIndex(null);
		setDropTargetIndex(null);
		resizeDragRef.current = null;
	}, [metadata.sourceId]);

	const persistWidths = useCallback(
		(next: Record<string, number>) => {
			setSavedColumnWidths(next);
			saveColumnWidths(metadata.sourceId, next);
		},
		[metadata.sourceId],
	);

	const moveColumn = useCallback(
		(from: number, to: number) => {
			const next = moveColumnOrder(columns, from, to);
			setSavedColumnOrder(next);
			saveColumnOrder(metadata.sourceId, next);
		},
		[columns, metadata.sourceId],
	);

	const startColumnResize = useCallback(
		(key: string, clientX: number, startWidth: number) => {
			resizeDragRef.current = { key, startX: clientX, startWidth };
		},
		[],
	);

	const updateColumnResize = useCallback((clientX: number) => {
		const drag = resizeDragRef.current;
		if (!drag) return;
		const nextWidth = clampColumnWidth(
			drag.startWidth + (clientX - drag.startX),
		);
		setSavedColumnWidths((prev) =>
			prev[drag.key] === nextWidth ? prev : { ...prev, [drag.key]: nextWidth },
		);
	}, []);

	const endColumnResize = useCallback(() => {
		resizeDragRef.current = null;
		// The re-rendered handle closure holds the latest widths.
		saveColumnWidths(metadata.sourceId, savedColumnWidths);
	}, [metadata.sourceId, savedColumnWidths]);

	const resetColumnWidth = useCallback(
		(key: string) => {
			const next = { ...savedColumnWidths };
			delete next[key];
			persistWidths(next);
		},
		[savedColumnWidths, persistWidths],
	);

	const resetColumns = useCallback(() => {
		setSavedColumnOrder(null);
		persistWidths({});
		try {
			localStorage.removeItem(
				`${COLUMN_ORDER_STORAGE_PREFIX}${metadata.sourceId}`,
			);
		} catch {
			// Ignore storage errors — layout still resets this session.
		}
	}, [metadata.sourceId, persistWidths]);

	useEffect(() => {
		onScrollContainerChange?.(scrollRef.current);
		return () => onScrollContainerChange?.(null);
	}, [onScrollContainerChange]);

	useEffect(() => {
		// Participates in dependencies as an explicit user refresh signal.
		void refreshToken;
		let disposed = false;
		const loadRows = async () => {
			setStatus("loading");
			setError(null);
			try {
				const nextQuery = await desktopApi.queryNotionDatabase({
					sourceId: metadata.sourceId,
					sourceObject: metadata.object,
					account: metadata.account,
					startCursor: currentCursor,
					pageSize: metadata.pageSize,
				});
				if (disposed) return;
				setQuery(nextQuery);
				setStatus("ready");
			} catch (error) {
				if (disposed) return;
				setError(error instanceof Error ? error.message : String(error));
				setStatus("error");
			}
		};
		void loadRows();
		return () => {
			disposed = true;
		};
	}, [
		currentCursor,
		metadata.account,
		metadata.object,
		metadata.pageSize,
		metadata.sourceId,
		refreshToken,
	]);

	async function openRow(row: NotionDatabaseQueryResult["rows"][number]) {
		try {
			await openOrImportNotionPage(
				{
					id: row.pageId,
					object: "page",
					account: metadata.account,
					title: row.title || "Untitled Notion page",
					url: row.url,
					lastEditedTime: row.lastEditedTime,
				},
				{ folderPath: detailFolderPath },
			);
		} catch (error) {
			toast.error("Failed to open Notion row", {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
				<h1 className="m-0 min-w-0 truncate text-sm font-medium">
					{metadata.title}
				</h1>
				<div className="flex items-center gap-2">
					{isCustomized ? (
						<Button size="sm" variant="ghost" onClick={resetColumns}>
							Reset columns
						</Button>
					) : null}
					<Button
						disabled={cursorStack.length <= 1 || status === "loading"}
						size="sm"
						variant="outline"
						onClick={() =>
							setCursorStack((stack) =>
								stack.length <= 1 ? stack : stack.slice(0, -1),
							)
						}
					>
						Previous
					</Button>
					<Button
						disabled={
							!query?.hasMore || !query.nextCursor || status === "loading"
						}
						size="sm"
						variant="outline"
						onClick={() => {
							if (!query?.nextCursor) return;
							setCursorStack((stack) => [...stack, query.nextCursor]);
						}}
					>
						Next
					</Button>
				</div>
			</header>
			<div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
				{status === "loading" ? (
					<p className="m-0 p-3 text-sm text-muted-foreground">Loading...</p>
				) : null}
				{status === "error" ? (
					<p className="m-0 p-3 text-sm text-destructive">
						{error ?? "Failed to load Notion database."}
					</p>
				) : null}
				{status === "ready" && query?.rows.length === 0 ? (
					<p className="m-0 p-3 text-sm text-muted-foreground">No rows</p>
				) : null}
				{status === "ready" && query && query.rows.length > 0 ? (
					<table
						className="w-full min-w-max border-separate border-spacing-0 text-sm"
						style={hasCustomWidths ? { tableLayout: "fixed" } : undefined}
					>
						{hasCustomWidths ? (
							<colgroup>
								<col
									style={
										savedColumnWidths[ROW_COLUMN_KEY] !== undefined
											? { width: savedColumnWidths[ROW_COLUMN_KEY] }
											: undefined
									}
								/>
								{columns.map((column) => (
									<col
										key={column}
										style={
											savedColumnWidths[column] !== undefined
												? { width: savedColumnWidths[column] }
												: undefined
										}
									/>
								))}
							</colgroup>
						) : null}
						<thead>
							<tr>
								<th className="group sticky top-0 z-10 border-b border-border bg-background px-3 py-2 text-start font-medium">
									Row
									<ColumnResizeHandle
										onResizeStart={(clientX, startWidth) =>
											startColumnResize(ROW_COLUMN_KEY, clientX, startWidth)
										}
										onResizeMove={updateColumnResize}
										onResizeEnd={endColumnResize}
										onReset={() => resetColumnWidth(ROW_COLUMN_KEY)}
									/>
								</th>
								{columns.map((column, index) => (
									<th
										key={column}
										draggable
										tabIndex={0}
										title="Drag to reorder (Alt+←/→ to move)"
										aria-label={`${column}, column ${index + 1} of ${columns.length}. Press Alt plus arrow keys to reorder.`}
										onDragStart={(event) => {
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
											event.preventDefault();
											event.dataTransfer.dropEffect = "move";
											if (index !== dragSourceIndex) {
												setDropTargetIndex(index);
											}
										}}
										onDrop={(event) => {
											event.preventDefault();
											if (dragSourceIndex !== null) {
												moveColumn(dragSourceIndex, index);
											}
											setDragSourceIndex(null);
											setDropTargetIndex(null);
										}}
										onDragEnd={() => {
											setDragSourceIndex(null);
											setDropTargetIndex(null);
										}}
										onKeyDown={(event) => {
											if (!event.altKey) return;
											if (event.key === "ArrowLeft") {
												event.preventDefault();
												moveColumn(index, index - 1);
											} else if (event.key === "ArrowRight") {
												event.preventDefault();
												moveColumn(index, index + 1);
											}
										}}
										className={`group sticky top-0 z-10 cursor-grab border-b border-border bg-background px-3 py-2 text-start font-medium select-none ${
											dragSourceIndex === index ? "opacity-40" : ""
										} ${dropTargetIndex === index ? "bg-muted" : ""}`}
									>
										<span aria-hidden="true" className="mr-1 opacity-40">
											⠿
										</span>
										{column}
										<ColumnResizeHandle
											onResizeStart={(clientX, startWidth) =>
												startColumnResize(column, clientX, startWidth)
											}
											onResizeMove={updateColumnResize}
											onResizeEnd={endColumnResize}
											onReset={() => resetColumnWidth(column)}
										/>
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{query.rows.map((row) => (
								<tr key={row.pageId} className="hover:bg-muted/40">
									<td className="max-w-80 border-b border-border px-3 py-2 align-top">
										<button
											className="max-w-full truncate text-start text-primary outline-hidden hover:underline focus-visible:underline"
											type="button"
											onClick={() => void openRow(row)}
										>
											{row.title || "Untitled"}
										</button>
									</td>
									{columns.map((column) => (
										<td
											key={`${row.pageId}:${column}`}
											className="max-w-80 border-b border-border px-3 py-2 align-top text-muted-foreground"
										>
											<span className="line-clamp-3 whitespace-pre-wrap">
												{row.properties[column] ?? ""}
											</span>
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				) : null}
			</div>
		</div>
	);
}
