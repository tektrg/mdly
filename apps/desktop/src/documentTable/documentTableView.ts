// The same matcher the command palette runs (`lib/fileSearch.ts`), through the
// UI-free entry point. Two search boxes in one app must never disagree about
// which documents a query finds.
import { normalizeSearchText } from "@mdly/workspace-kit/search";
import {
	basename,
	dirname,
	extname,
	hasMarkdownExtension,
	relativeWorkspacePath,
} from "../lib/filePath";
import type { FileEntry } from "../store/state";
import type { NavGroupBy, NavViewMode } from "./navGroupTree";

export type DocumentTableColumn = "name" | "folder" | "modified";
export type DocumentTableSortDirection = "asc" | "desc";

export type DocumentTableSort = {
	column: DocumentTableColumn;
	direction: DocumentTableSortDirection;
};

/**
 * Everything that parameterizes the document table. Phase 3's saved views pass
 * one of these instead of the session's own, which is why filter and sort are a
 * single value rather than two component-local `useState`s.
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
	 * Match-only form of the file name, extension included — `normalizeSearchText`
	 * collapses case and separators, which is what lets `my project` find
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

export function createDefaultDocumentTableView(): DocumentTableView {
	return {
		filter: "",
		sort: { column: "modified", direction: "desc" },
		groupBy: null,
		mode: "browse",
	};
}

/**
 * Header click semantics: the same column flips direction; a new column starts
 * ascending — except Modified, which starts descending, because "newest first"
 * is the useful default for a date column (and is the table's own default sort).
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
	return { column, direction: column === "modified" ? "desc" : "asc" };
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
		searchName: normalizeSearchText(basename(file.path)),
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
}

/**
 * `normalizedFilter` is the query already through `normalizeSearchText`, so this
 * runs once per row per keystroke and never re-normalizes.
 *
 * File name only, never the folder path: filtering on the path would make a
 * folder name silently widen the result set the user thinks they are narrowing.
 * The name it matches keeps its extension, unlike the displayed `name` — the
 * extension is part of what Finder and the command palette show, so typing
 * `readme.md` is a narrowing intent, not a typo. Substring, not the palette's
 * full `scoreText`: this box filters a list the user has already sorted, so the
 * palette's loosest subsequence tier (`mtg` finds `meeting`) would only add
 * rows the user did not ask for, with no relevance ranking to justify them.
 */
function matchesFilter(
	row: DocumentTableRow,
	normalizedFilter: string,
): boolean {
	if (normalizedFilter.length === 0) return true;
	return row.searchName.includes(normalizedFilter);
}

function comparePaths(a: DocumentTableRow, b: DocumentTableRow): number {
	// Every comparator ends here. Equal sort keys are common (a git checkout or an
	// unzip gives a whole tree the same mtime) and directory listing order is not
	// guaranteed, so without this the list would re-shuffle on every watcher event
	// — and the R4 reorder animation would make that jitter loudly visible.
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function compareByColumn(
	a: DocumentTableRow,
	b: DocumentTableRow,
	column: DocumentTableColumn,
): number {
	switch (column) {
		case "name":
			return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
		case "folder":
			return a.folderLabel.localeCompare(b.folderLabel, undefined, {
				sensitivity: "base",
			});
		case "modified":
			return a.modifiedAt - b.modifiedAt;
	}
}

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
	const direction = view.sort.direction === "desc" ? -1 : 1;
	const normalizedFilter = normalizeSearchText(view.filter);
	// Resolved once against the unfiltered rows, so the filtered list and the R6
	// pin below can never disagree about which row is the open document.
	const activeRowPath =
		activePath === null ? null : resolveActiveRowPath(rows, activePath);
	const visible = rows
		.filter((row) => matchesFilter(row, normalizedFilter))
		.sort(
			(a, b) =>
				compareByColumn(a, b, view.sort.column) * direction ||
				comparePaths(a, b),
		)
		.map((row) =>
			row.path === activeRowPath ? { ...row, isActive: true } : row,
		);

	if (activeRowPath === null || visible.some((row) => row.isActive))
		return visible;

	const pinned = rows.find((row) => row.path === activeRowPath);
	if (!pinned) return visible;
	return [{ ...pinned, isActive: true, isPinnedOffFilter: true }, ...visible];
}
