import {
	fileNameFromPath,
	normalizeDisplayPath,
	splitFileName,
} from "../lib/filePath";
import { normalizeSearchText, scoreText } from "./searchScore";
import type { SidebarFile } from "./useSidebarTree";

/** A file with its display fields and normalized haystacks computed once. */
export type SidebarSearchIndexEntry = {
	file: SidebarFile;
	/** `getDisplayPath(file.path)`, normalized for display -- what the user reads. */
	displayPath: string;
	/** Leaf of `displayPath`; the row's visible label. */
	label: string;
	searchLabel: string;
	searchStem: string;
	searchDisplayPath: string;
	searchAbsolutePath: string;
};

export type SidebarSearchResult = {
	file: SidebarFile;
	displayPath: string;
	label: string;
	/** Higher is better. Exposed so ranking is assertable without a DOM. */
	score: number;
};

/**
 * Ceilings per field, strongest first. A perfect match on a weak field can
 * never outrank a perfect match on a strong one, but a *scattered* match on a
 * strong field still beats a perfect match on the weakest -- which is what
 * makes `mtg` find `Team Meeting.md` rather than some unrelated path.
 */
const LABEL_SCORE = 100;
const STEM_SCORE = 98;
const DISPLAY_PATH_SCORE = 78;
const ABSOLUTE_PATH_SCORE = 35;

/**
 * Builds the reusable haystacks for one file-list snapshot. Rebuild when the
 * files (or the host's `getDisplayPath`) change -- never per keystroke, which
 * is where the normalization cost would otherwise land.
 *
 * Deliberately searches what the user can *see*, not just the path on disk.
 * `SidebarFile` has no title field, but every host already supplies
 * `getDisplayPath` for the tree's labels -- in mdly that is the
 * workspace-relative path, in SpeechToDo the recording's title. Scoring it is
 * what makes a query match the words actually on screen. The absolute path
 * stays in as the weakest field so a file is still findable by its on-disk
 * name when the friendly title has drifted away from it.
 */
export function buildSidebarSearchIndex(
	files: readonly SidebarFile[],
	getDisplayPath: (path: string) => string,
): SidebarSearchIndexEntry[] {
	return files.map((file) => {
		const displayPath = normalizeDisplayPath(getDisplayPath(file.path));
		const label = fileNameFromPath(displayPath);
		return {
			file,
			displayPath,
			label,
			searchLabel: normalizeSearchText(label),
			searchStem: normalizeSearchText(splitFileName(label).name),
			searchDisplayPath: normalizeSearchText(displayPath),
			searchAbsolutePath: normalizeSearchText(file.path),
		};
	});
}

/**
 * Ranks a prebuilt index against a query. The per-keystroke hot path: reads
 * only precomputed fields, normalizing nothing but the query itself.
 *
 * Unbounded by design. Callers show these rows in a virtualized list that
 * stays cheap at any length, and a silent top-N cut would read as "that file
 * doesn't exist" rather than "there were more".
 */
export function searchSidebarFiles({
	index,
	query,
	currentPath = null,
}: {
	index: readonly SidebarSearchIndexEntry[];
	query: string;
	/** Breaks score ties toward the file the user is already looking at. */
	currentPath?: string | null;
}): SidebarSearchResult[] {
	const needle = normalizeSearchText(query);
	const scored: (SidebarSearchResult & { currentBoost: number })[] = [];
	for (const entry of index) {
		const score = needle
			? Math.max(
					scoreText(entry.searchLabel, needle, LABEL_SCORE),
					scoreText(entry.searchStem, needle, STEM_SCORE),
					scoreText(entry.searchDisplayPath, needle, DISPLAY_PATH_SCORE),
					scoreText(entry.searchAbsolutePath, needle, ABSOLUTE_PATH_SCORE),
				)
			: 1;
		if (score <= 0) continue;
		scored.push({
			file: entry.file,
			displayPath: entry.displayPath,
			label: entry.label,
			score,
			currentBoost: entry.file.path === currentPath ? 1 : 0,
		});
	}

	return scored
		.sort((a, b) => {
			const byScore = b.score - a.score;
			if (byScore !== 0) return byScore;
			const byCurrent = b.currentBoost - a.currentBoost;
			if (byCurrent !== 0) return byCurrent;
			// `modifiedAt` is optional on SidebarFile; missing sorts last rather
			// than poisoning the comparison with NaN.
			const byModified = (b.file.modifiedAt ?? 0) - (a.file.modifiedAt ?? 0);
			if (byModified !== 0) return byModified;
			return a.displayPath.localeCompare(b.displayPath);
		})
		.map(({ currentBoost: _currentBoost, ...result }) => result);
}

/** Index-then-rank in one call, for one-shot callers and tests. */
export function buildSearchResults({
	files,
	query,
	getDisplayPath,
	currentPath = null,
}: {
	files: readonly SidebarFile[];
	query: string;
	getDisplayPath: (path: string) => string;
	currentPath?: string | null;
}): SidebarSearchResult[] {
	return searchSidebarFiles({
		index: buildSidebarSearchIndex(files, getDisplayPath),
		query,
		currentPath,
	});
}
