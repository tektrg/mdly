import { Button } from "@hubble.md/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MingcuteLayoutLeftLine from "~icons/mingcute/layout-left-line";
import MingcuteSearchLine from "~icons/mingcute/search-line";
import { queryDatabase } from "../api/client";
import type {
	NotionDatabaseQueryResult,
	NotionSearchResult,
} from "../notion/types";

type Props = {
	source: NotionSearchResult;
	onOpenRow: (row: {
		pageId: string;
		title: string;
		url: string | null;
	}) => void;
	onOpenMenu: () => void;
	onOpenSearch: () => void;
};

/**
 * Collapse-mode priority: column order is the priority order. Narrow widths
 * show only the first non-empty properties; wider containers reveal more.
 */
export function collapsedVisiblePropertyCount(
	containerWidthPx: number,
	totalColumns: number,
): number {
	if (totalColumns <= 0) return 0;
	if (containerWidthPx < 380) return Math.min(1, totalColumns);
	if (containerWidthPx < 520) return Math.min(2, totalColumns);
	if (containerWidthPx < 640) return Math.min(3, totalColumns);
	return totalColumns;
}

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

const COLUMN_ORDER_STORAGE_PREFIX = "mdly-db-column-order:";

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

const TITLE_COLUMN_KEY = "__title";
const COLUMN_WIDTH_STORAGE_PREFIX = "mdly-db-column-widths:";
const MIN_COLUMN_WIDTH_PX = 80;
const MAX_COLUMN_WIDTH_PX = 640;

/** Pure clamp for resize drags. */
export function clampColumnWidth(widthPx: number): number {
	if (!Number.isFinite(widthPx)) return MIN_COLUMN_WIDTH_PX;
	return Math.min(
		MAX_COLUMN_WIDTH_PX,
		Math.max(MIN_COLUMN_WIDTH_PX, Math.round(widthPx)),
	);
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
 * Right-edge handle for resizing one desktop table column.
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
				className="absolute inset-y-1 end-0.5 w-px bg-[var(--primary)] opacity-0 group-hover:opacity-100"
			/>
		</span>
	);
}

function useCollapsedVisibleCount(totalColumns: number) {
	const containerRef = useRef<HTMLUListElement | null>(null);
	const [visibleCount, setVisibleCount] = useState(totalColumns);

	useEffect(() => {
		const element = containerRef.current;
		if (!element) {
			setVisibleCount(totalColumns);
			return;
		}
		const update = (width: number) => {
			setVisibleCount(collapsedVisiblePropertyCount(width, totalColumns));
		};
		update(element.clientWidth);
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				update(entry.contentRect.width);
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [totalColumns]);

	return { containerRef, visibleCount };
}

export function DatabaseViewer({
	source,
	onOpenRow,
	onOpenMenu,
	onOpenSearch,
}: Props) {
	const [state, setState] = useState<
		| { status: "loading" }
		| { status: "error"; message: string }
		| { status: "ready"; data: NotionDatabaseQueryResult }
	>({ status: "loading" });
	const [headerHidden, setHeaderHidden] = useState(false);
	const lastScrollTopRef = useRef(0);
	const [savedColumnOrder, setSavedColumnOrder] = useState<string[] | null>(
		() => loadSavedColumnOrder(source.id),
	);
	const [dragSourceIndex, setDragSourceIndex] = useState<number | null>(null);
	const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
	const [savedColumnWidths, setSavedColumnWidths] = useState<
		Record<string, number>
	>(() => loadSavedColumnWidths(source.id));
	const resizeDragRef = useRef<{
		key: string;
		startX: number;
		startWidth: number;
	} | null>(null);
	const serverColumns =
		state.status === "ready" ? state.data.columns : undefined;
	const orderedColumns = useMemo(
		() =>
			serverColumns
				? applySavedColumnOrder(serverColumns, savedColumnOrder)
				: [],
		[serverColumns, savedColumnOrder],
	);
	const totalColumns = orderedColumns.length;
	const { containerRef, visibleCount } = useCollapsedVisibleCount(totalColumns);

	// Reload the saved order when switching databases, so each database
	// keeps its own layout.
	useEffect(() => {
		setSavedColumnOrder(loadSavedColumnOrder(source.id));
		setSavedColumnWidths(loadSavedColumnWidths(source.id));
		setDragSourceIndex(null);
		setDropTargetIndex(null);
		resizeDragRef.current = null;
	}, [source.id]);

	const persistReorder = useCallback(
		(next: string[]) => {
			setSavedColumnOrder(next);
			saveColumnOrder(source.id, next);
		},
		[source.id],
	);

	const moveColumn = useCallback(
		(from: number, to: number) => {
			persistReorder(moveColumnOrder(orderedColumns, from, to));
		},
		[orderedColumns, persistReorder],
	);

	const persistWidths = useCallback(
		(next: Record<string, number>) => {
			setSavedColumnWidths(next);
			saveColumnWidths(source.id, next);
		},
		[source.id],
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
		saveColumnWidths(source.id, savedColumnWidths);
	}, [source.id, savedColumnWidths]);

	const resetColumnWidth = useCallback(
		(key: string) => {
			const next = { ...savedColumnWidths };
			delete next[key];
			persistWidths(next);
		},
		[savedColumnWidths, persistWidths],
	);

	useEffect(() => {
		let cancelled = false;
		setState({ status: "loading" });
		queryDatabase(
			source.id,
			source.object === "data_source" ? "data_source" : "database",
		)
			.then((data) => {
				if (!cancelled) setState({ status: "ready", data });
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					setState({
						status: "error",
						message:
							error instanceof Error
								? error.message
								: "Could not load this database.",
					});
				}
			});
		return () => {
			cancelled = true;
		};
	}, [source.id, source.object]);

	return (
		<div className="flex h-full min-w-0 flex-1 flex-col">
			<div
				className={`shrink-0 overflow-hidden border-b border-[var(--border)] transition-[max-height] duration-200 ease-in-out md:max-h-none ${
					headerHidden ? "max-h-0 border-b-0" : "max-h-14"
				}`}
			>
				<header className="flex items-center gap-1 px-2 py-2 sm:px-4 sm:py-2.5">
					<Button
						variant="ghost"
						size="icon"
						aria-label="Open menu"
						title="Open menu"
						onClick={onOpenMenu}
						className="size-9 shrink-0 md:hidden"
					>
						<MingcuteLayoutLeftLine className="size-4" />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						aria-label="Search Notion"
						title="Search Notion"
						onClick={onOpenSearch}
						className="size-9 shrink-0 md:hidden"
					>
						<MingcuteSearchLine className="size-4" />
					</Button>
					<div className="min-w-0 flex-1">
						<h2 className="truncate text-sm font-medium">{source.title}</h2>
						<p className="truncate text-xs opacity-50">
							Read-only database view
						</p>
					</div>
				</header>
			</div>
			<div
				className="min-h-0 flex-1 overflow-auto p-4"
				onScroll={(event) => {
					const scrollTop = event.currentTarget.scrollTop;
					const delta = scrollTop - lastScrollTopRef.current;
					lastScrollTopRef.current = scrollTop;
					if (scrollTop <= 0 || delta < -4) {
						setHeaderHidden(false);
					} else if (delta > 4) {
						setHeaderHidden(true);
					}
				}}
			>
				{state.status === "loading" ? (
					<p className="text-sm opacity-60">Loading rows…</p>
				) : state.status === "error" ? (
					<p className="text-sm text-red-500">{state.message}</p>
				) : state.data.rows.length === 0 ? (
					<p className="text-sm opacity-60">No rows.</p>
				) : (
					<>
						<ul ref={containerRef} className="flex flex-col gap-2 md:hidden">
							{state.data.rows.map((row) => {
								const filledColumns = orderedColumns.filter(
									(column) => row.properties[column],
								);
								const shownColumns = filledColumns.slice(0, visibleCount);
								const hiddenCount = filledColumns.length - shownColumns.length;
								return (
									<li key={row.pageId}>
										<button
											type="button"
											onClick={() =>
												onOpenRow({
													pageId: row.pageId,
													title: row.title,
													url: row.url,
												})
											}
											className="flex w-full flex-col gap-1 rounded-md border border-[var(--border)] px-3 py-2.5 text-left hover:bg-[var(--muted)]"
										>
											<span className="text-sm font-medium">{row.title}</span>
											{shownColumns.map((column) => (
												<span key={column} className="text-xs opacity-70">
													<span className="opacity-50">{column}: </span>
													{row.properties[column]}
												</span>
											))}
											{hiddenCount > 0 ? (
												<span className="text-xs opacity-50">
													+{hiddenCount} more
												</span>
											) : null}
										</button>
									</li>
								);
							})}
						</ul>
						{orderedColumns.join("|") !== state.data.columns.join("|") ||
						Object.keys(savedColumnWidths).length > 0 ? (
							<div className="mb-2 hidden justify-end md:flex">
								<button
									type="button"
									onClick={() => {
										setSavedColumnOrder(null);
										persistWidths({});
										try {
											localStorage.removeItem(
												`${COLUMN_ORDER_STORAGE_PREFIX}${source.id}`,
											);
										} catch {
											// Ignore storage errors — order still resets this session.
										}
									}}
									className="text-xs opacity-60 hover:opacity-100 hover:underline"
								>
									Reset columns
								</button>
							</div>
						) : null}
						<table
							className="hidden w-full border-collapse text-sm md:table"
							style={
								Object.keys(savedColumnWidths).length > 0
									? { tableLayout: "fixed" }
									: undefined
							}
						>
							{Object.keys(savedColumnWidths).length > 0 ? (
								<colgroup>
									<col
										style={
											savedColumnWidths[TITLE_COLUMN_KEY] !== undefined
												? { width: savedColumnWidths[TITLE_COLUMN_KEY] }
												: undefined
										}
									/>
									{orderedColumns.map((column) => (
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
								<tr className="border-b border-[var(--border)] text-left">
									<th className="group relative px-2 py-1.5 font-medium">
										Title
										<ColumnResizeHandle
											onResizeStart={(clientX, startWidth) =>
												startColumnResize(TITLE_COLUMN_KEY, clientX, startWidth)
											}
											onResizeMove={updateColumnResize}
											onResizeEnd={endColumnResize}
											onReset={() => resetColumnWidth(TITLE_COLUMN_KEY)}
										/>
									</th>
									{orderedColumns.map((column, index) => (
										<th
											key={column}
											draggable
											tabIndex={0}
											title="Drag to reorder (Alt+←/→ to move)"
											aria-label={`${column}, column ${index + 1} of ${orderedColumns.length}. Press Alt plus arrow keys to reorder.`}
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
											className={`group relative cursor-grab px-2 py-1.5 font-medium select-none ${
												dragSourceIndex === index ? "opacity-40" : ""
											} ${dropTargetIndex === index ? "bg-[var(--muted)]" : ""}`}
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
								{state.data.rows.map((row) => (
									<tr
										key={row.pageId}
										className="border-b border-[var(--border)]/50 hover:bg-[var(--muted)]"
									>
										<td className="px-2 py-1.5">
											<button
												type="button"
												onClick={() =>
													onOpenRow({
														pageId: row.pageId,
														title: row.title,
														url: row.url,
													})
												}
												className="text-left underline-offset-2 hover:underline"
											>
												{row.title}
											</button>
										</td>
										{orderedColumns.map((column) => (
											<td key={column} className="px-2 py-1.5 opacity-80">
												{row.properties[column] ?? ""}
											</td>
										))}
									</tr>
								))}
							</tbody>
						</table>
					</>
				)}
			</div>
		</div>
	);
}
