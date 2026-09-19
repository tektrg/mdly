import type { CSSProperties } from "react";
import { useSyncExternalStore } from "react";
import type { DocumentTableColumn } from "./documentTableView";

/**
 * Column order + widths for the All-documents table, shared by the
 * full-width header, the body rows, and the narrow list's secondary line.
 *
 * One external store (not component state) so the header and the virtualized
 * rows — mounted together but in different subtrees — can never disagree.
 * Persisted globally in localStorage: the column set is fixed, so there is
 * nothing per-workspace to key on. Name is pinned first; only folder and
 * modified participate in reorder.
 */

export const DEFAULT_COLUMN_ORDER: DocumentTableColumn[] = [
	"name",
	"folder",
	"modified",
];

const DEFAULT_TRACK: Record<DocumentTableColumn, string> = {
	// Mirrors DOCUMENT_TABLE_GRID_TEMPLATE literal for literal, so the default
	// render is byte-identical with or without this module in the path.
	name: "minmax(0,1fr)",
	folder: "minmax(0,11rem)",
	modified: "minmax(0,10rem)",
};

const ORDER_STORAGE_KEY = "mdly-doc-table-column-order";
const WIDTH_STORAGE_KEY = "mdly-doc-table-column-widths";

export const MIN_COLUMN_WIDTH_PX = 80;
export const MAX_COLUMN_WIDTH_PX = 640;

function isTableColumn(value: unknown): value is DocumentTableColumn {
	return value === "name" || value === "folder" || value === "modified";
}

/** Pure reorder with the Name-first pin baked in: index 0 never moves. */
export function moveColumnOrder(
	columns: DocumentTableColumn[],
	from: number,
	to: number,
): DocumentTableColumn[] {
	if (from < 1 || to < 1 || from >= columns.length || to >= columns.length) {
		return columns;
	}
	if (from === to) return columns;
	const next = [...columns];
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	return next;
}

/** Pure clamp for resize drags. */
export function clampColumnWidth(widthPx: number): number {
	if (!Number.isFinite(widthPx)) return MIN_COLUMN_WIDTH_PX;
	return Math.min(
		MAX_COLUMN_WIDTH_PX,
		Math.max(MIN_COLUMN_WIDTH_PX, Math.round(widthPx)),
	);
}

/**
 * Totally-ordered merge for loaded saves: unknown entries drop out, columns
 * added since the save (none today, but free) append, Name forced first so a
 * stale save can never unpin it.
 */
export function normalizeColumnOrder(saved: unknown): DocumentTableColumn[] {
	const kept = Array.isArray(saved) ? saved.filter(isTableColumn) : [];
	const missing = DEFAULT_COLUMN_ORDER.filter(
		(column) => !kept.includes(column),
	);
	const merged = [...kept, ...missing];
	return ["name", ...merged.filter((column) => column !== "name")];
}

function loadOrder(): DocumentTableColumn[] {
	try {
		const raw = localStorage.getItem(ORDER_STORAGE_KEY);
		if (!raw) return [...DEFAULT_COLUMN_ORDER];
		return normalizeColumnOrder(JSON.parse(raw) as unknown);
	} catch {
		return [...DEFAULT_COLUMN_ORDER];
	}
}

function loadWidths(): Partial<Record<DocumentTableColumn, number>> {
	try {
		const raw = localStorage.getItem(WIDTH_STORAGE_KEY);
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return {};
		const widths: Partial<Record<DocumentTableColumn, number>> = {};
		for (const [key, value] of Object.entries(
			parsed as Record<string, unknown>,
		)) {
			if (isTableColumn(key) && typeof value === "number") {
				widths[key] = clampColumnWidth(value);
			}
		}
		return widths;
	} catch {
		return {};
	}
}

function persist(order: DocumentTableColumn[], widths: object) {
	try {
		localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(order));
		localStorage.setItem(WIDTH_STORAGE_KEY, JSON.stringify(widths));
	} catch {
		// Storage full or unavailable — layout still applies for this session.
	}
}

type LayoutSnapshot = {
	order: DocumentTableColumn[];
	widths: Partial<Record<DocumentTableColumn, number>>;
};

let snapshot: LayoutSnapshot = {
	order: loadOrder(),
	widths: loadWidths(),
};
let version = 0;
const listeners = new Set<() => void>();

function emit() {
	version += 1;
	persist(snapshot.order, snapshot.widths);
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function getVersion(): number {
	return version;
}

function getSnapshot(): LayoutSnapshot {
	return snapshot;
}

export function moveDocumentTableColumn(from: number, to: number) {
	const next = moveColumnOrder(snapshot.order, from, to);
	if (next === snapshot.order) return;
	snapshot = { ...snapshot, order: next };
	emit();
}

export function setDocumentTableColumnWidth(
	column: DocumentTableColumn,
	widthPx: number,
) {
	const nextWidth = clampColumnWidth(widthPx);
	if (snapshot.widths[column] === nextWidth) return;
	snapshot = {
		...snapshot,
		widths: { ...snapshot.widths, [column]: nextWidth },
	};
	emit();
}

export function resetDocumentTableColumnWidth(column: DocumentTableColumn) {
	if (snapshot.widths[column] === undefined) return;
	const next = { ...snapshot.widths };
	delete next[column];
	snapshot = { ...snapshot, widths: next };
	emit();
}

export function resetDocumentTableLayout() {
	snapshot = { order: [...DEFAULT_COLUMN_ORDER], widths: {} };
	emit();
}

/** Test seam: re-reads storage so fixtures cannot leak between cases. */
export function resetDocumentTableLayoutForTests() {
	snapshot = { order: loadOrder(), widths: loadWidths() };
	version += 1;
	for (const listener of listeners) listener();
}

/**
 * Inline grid template for an ordered column set. Returns undefined while the
 * layout is stock, so the Tailwind grid literal stays the single source of
 * truth — inline style only ever overrides it, never duplicates it.
 */
export function gridTemplateFor(
	columns: DocumentTableColumn[],
	widths: Partial<Record<DocumentTableColumn, number>>,
): CSSProperties | undefined {
	const customWidths = columns.some((column) => widths[column] !== undefined);
	const reordered = columns.join("|") !== DEFAULT_COLUMN_ORDER.join("|");
	if (!customWidths && !reordered) return undefined;
	return {
		gridTemplateColumns: columns
			.map((column) =>
				widths[column] !== undefined
					? `${widths[column]}px`
					: DEFAULT_TRACK[column],
			)
			.join(" "),
	};
}

/** The narrow list's secondary line: first data column in the live order. */
export function secondaryColumnFor(
	columns: DocumentTableColumn[],
): DocumentTableColumn {
	return columns.find((column) => column !== "name") ?? "folder";
}

export type DocumentTableLayout = {
	columns: DocumentTableColumn[];
	widths: Partial<Record<DocumentTableColumn, number>>;
	gridStyle: CSSProperties | undefined;
	secondaryColumn: DocumentTableColumn;
	isCustomized: boolean;
};

export function useDocumentTableLayout(): DocumentTableLayout {
	useSyncExternalStore(subscribe, getVersion, getVersion);
	const { order, widths } = getSnapshot();
	return {
		columns: order,
		widths,
		gridStyle: gridTemplateFor(order, widths),
		secondaryColumn: secondaryColumnFor(order),
		isCustomized:
			Object.keys(widths).length > 0 ||
			order.join("|") !== DEFAULT_COLUMN_ORDER.join("|"),
	};
}
