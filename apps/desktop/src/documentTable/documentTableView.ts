// Filter and sort run on the portfolio table engine (`documentTableEngine.ts`);
// its loose match is the command palette's `normalizeSearchText` rule plus
// accent folding, so the two search boxes still agree on separators and case.
import { looseFoldText } from "@tektrg/table-core";
import {
	basename,
	dirname,
	extname,
	hasMarkdownExtension,
	relativeWorkspacePath,
} from "../lib/filePath";
import type { FileEntry } from "../store/state";
import {
	filterAndSortDocumentRows,
	resetDocumentSortMemo,
} from "./documentTableEngine";
import type { NavGroupBy, NavViewMode } from "./navGroupTree";

export type DocumentTableColumn = "name" | "folder" | "modified" | "created";
export type DocumentTableSortDirection = "asc" | "desc";

export type DocumentTableSort = {
	column: DocumentTableColumn;
	direction: DocumentTableSortDirection;
};

/**
 * The sort every nav view starts with until the user picks another. One
 * constant for all views, so "no saved entry" has exactly one meaning.
 */
export const DEFAULT_NAV_VIEW_SORT: DocumentTableSort = {
	column: "modified",
	direction: "desc",
};

/**
 * Everything that parameterizes the document table. Phase 3's saved views pass
 * one of these instead of the session's own, which is why filter and sort are a
 * single value rather than two component-local `useState`s.
 *
 * `sort` is not session state: it is the current nav view's persisted sort,
 * composed in by `useDocumentTableRows` (see `navViewSort.ts`).
 */
export type DocumentTableView = {
	filter: string;
	sort: DocumentTableSort;
	/**
	 * The field rows are grouped on; `null` is the flat list. Folder view and tag
	 * view are this one field, not two components (R2).
	 */
	groupBy: NavGroupBy;
	/**
	 * Browsing, or ranked search. ONE store owns the view, so there is no second
	 * store for a mode to disagree with (defect 4). `filter` is the query text in
	 * both modes; only `resolveNavViewSpec` reads the two together (A7).
	 */
	mode: NavViewMode;
};

export type DocumentTableRow = {
	/** Workspace entry path — the row's identity, and what name/folder derive from. */
	path: string;
	/**
	 * The path to hand `loadPath`. Equals `path` except for a live symlink, where
	 * it is the canonical target, so no row is ever a dead click (R2/O19).
	 */
	openPath: string;
	/** Basename without its markdown extension. */
	name: string;
	/** Workspace-relative parent folder; `—` for a file at the workspace root. */
	folderLabel: string;
	/** Seconds since the epoch, straight from `FileEntry.modified_at`. */
	modifiedAt: number;
	/**
	 * Seconds since the epoch, from `FileEntry.created_at` with a fallback to
	 * `modified_at` — listings predating the created column (and filesystems
	 * without a birthtime) still sort instead of rendering a blank column.
	 */
	createdAt: number;
	/**
	 * Match-only form of the file name, extension included — `looseFoldText`
	 * collapses case, accents and separators, which is what lets `my project` find
	 * `My-Project.md`. Precomputed here, in the listing-memoized projection, so
	 * the filter keystroke path never re-normalizes the workspace.
	 */
	searchName: string;
	isActive: boolean;
	/**
	 * True when this row only survives because it is the open document — the
	 * filter text excludes it, but dropping it would read as "my document closed"
	 * (R6).
	 */
	isPinnedOffFilter: boolean;
};

/** Folder cell for a document sitting directly in the workspace root. */
export const ROOT_FOLDER_LABEL = "—";

/** The part of the view that lives only for the session (never persisted). */
export type DocumentTableSessionView = Omit<DocumentTableView, "sort">;

export function createDefaultSessionView(): DocumentTableSessionView {
	return { filter: "", groupBy: null, mode: "browse" };
}

export function createDefaultDocumentTableView(): DocumentTableView {
	return { ...createDefaultSessionView(), sort: DEFAULT_NAV_VIEW_SORT };
}

/**
 * Header click semantics: the same column flips direction; a new column starts
 * ascending — except the date columns, which start descending, because
 * "newest first" is the useful default for a date column (and Modified is the
 * table's own default sort).
 */
export function toggleSort(
	currentSort: DocumentTableSort,
	column: DocumentTableColumn,
): DocumentTableSort {
	if (currentSort.column === column) {
		return {
			column,
			direction: currentSort.direction === "asc" ? "desc" : "asc",
		};
	}
	return {
		column,
		direction: column === "modified" || column === "created" ? "desc" : "asc",
	};
}

function isTableEligible(file: FileEntry): boolean {
	// R2: markdown only. The sidebar still lists .html HTML Apps and images; the
	// table must not, because every row has to be openable as a document.
	if (!hasMarkdownExtension(file.path)) return false;
	// A symlink whose target is gone would be a row that errors when clicked.
	if (file.is_symlink === true && file.symlink_target_exists === false) {
		return false;
	}
	return true;
}

function documentName(path: string): string {
	const name = basename(path);
	const extension = extname(path);
	return extension ? name.slice(0, -extension.length) : name;
}

function folderLabel(path: string, workspacePath: string | null): string {
	const parent = dirname(path);
	if (!parent) return ROOT_FOLDER_LABEL;
	if (!workspacePath) return parent;
	if (parent === workspacePath) return ROOT_FOLDER_LABEL;
	const relative = relativeWorkspacePath(parent, workspacePath);
	return relative.length > 0 ? relative : ROOT_FOLDER_LABEL;
}

function toRow(
	file: FileEntry,
	workspacePath: string | null,
): DocumentTableRow {
	const canonical =
		file.is_symlink === true ? file.symlink_canonical_path : null;
	return {
		path: file.path,
		openPath: canonical ?? file.path,
		name: documentName(file.path),
		folderLabel: folderLabel(file.path, workspacePath),
		modifiedAt: file.modified_at,
		createdAt: file.created_at ?? file.modified_at,
		searchName: looseFoldText(basename(file.path)),
		isActive: false,
		isPinnedOffFilter: false,
	};
}

type RowProjectionMemo = {
	files: FileEntry[];
	workspacePath: string | null;
	rows: DocumentTableRow[];
};

let rowProjectionMemo: RowProjectionMemo | null = null;

/**
 * Projects the workspace listing into table rows. O(files), and memoized on the
 * `files` array identity — `refreshFiles` replaces that array wholesale on every
 * change, so a bumped `modified_at` always produces a fresh projection while a
 * re-render with the same listing does not.
 *
 * Deliberately split from {@link applyDocumentTableView} so this pass stays off
 * the keystroke path: typing in the filter box re-runs filter+sort only.
 * Reads nothing from disk — everything comes from the listing already in memory.
 */
export function buildDocumentRows(
	files: FileEntry[],
	workspacePath: string | null,
): DocumentTableRow[] {
	if (
		rowProjectionMemo &&
		rowProjectionMemo.files === files &&
		rowProjectionMemo.workspacePath === workspacePath
	) {
		return rowProjectionMemo.rows;
	}
	const rows = files
		.filter(isTableEligible)
		.map((file) => toRow(file, workspacePath));
	rowProjectionMemo = { files, workspacePath, rows };
	return rows;
}

/** Test seam: drops the projection memo so fixtures cannot leak between cases. */
export function resetDocumentRowsMemo() {
	rowProjectionMemo = null;
	resetDocumentSortMemo();
}

// Filter semantics (owned by the engine adapter): file name only, never the
// folder path — filtering on the path would make a folder name silently widen
// the result set the user thinks they are narrowing. The name keeps its
// extension, so `readme.md` narrows. Substring, not the palette's subsequence
// tier (`mtg` finds `meeting`), because this box filters a list the user has
// already sorted. Equal sort keys fall back to path order, so the list never
// re-shuffles on watcher events (the R4 reorder animation would show it).

/**
 * The one row that reads as open, as its `path`.
 *
 * A row matches the open document either by its own `path` or — for a symlink —
 * by the canonical `openPath` it resolves to. When a symlink *and* its target
 * both live in the workspace, both rows match the same `activePath`, and marking
 * both would paint two selected rows, announce `aria-current` twice, and let
 * keyboard navigation land on whichever row came first. The direct hit wins: it
 * is the row whose identity actually is the open document. The symlink hit is
 * only a fallback, for when the target is outside the workspace and so has no
 * row of its own (R2/O19).
 */
function resolveActiveRowPath(
	rows: DocumentTableRow[],
	activePath: string,
): string | null {
	const directMatch = rows.find((row) => row.path === activePath);
	if (directMatch) return directMatch.path;
	return rows.find((row) => row.openPath === activePath)?.path ?? null;
}

/**
 * Applies a view to already-projected rows: filter, then sort, then R6 pinning.
 * Runs on every keystroke, so it never re-derives names or folder labels.
 *
 * R6 hybrid: an `activePath` that is in `rows` but excluded by the filter is
 * re-inserted at the top, flagged active and pinned. An `activePath` that is not
 * in `rows` at all — an `.html` HTML App, or a file outside the workspace — pins
 * nothing and selects nothing; the table never invents a row it excludes.
 */
export function applyDocumentTableView(
	rows: DocumentTableRow[],
	view: DocumentTableView,
	activePath: string | null = null,
): DocumentTableRow[] {
	// Resolved once against the unfiltered rows, so the filtered list and the R6
	// pin below can never disagree about which row is the open document.
	const activeRowPath =
		activePath === null ? null : resolveActiveRowPath(rows, activePath);
	const visible = filterAndSortDocumentRows(rows, view).map((row) =>
		row.path === activeRowPath ? { ...row, isActive: true } : row,
	);

	if (activeRowPath === null || visible.some((row) => row.isActive))
		return visible;

	const pinned = rows.find((row) => row.path === activeRowPath);
	if (!pinned) return visible;
	return [{ ...pinned, isActive: true, isPinnedOffFilter: true }, ...visible];
}
