import type { FileEntry } from "../store/state";
import {
	basename,
	extname,
	hasMarkdownExtension,
	pathInFolder,
	relativeWorkspacePath,
} from "./filePath";

export type FileSearchResult = {
	path: string;
	label: string;
	directory: string;
	relativePath: string;
	modifiedAt: number;
};

type SearchWorkspaceFilesInput = {
	files: FileEntry[];
	workspacePath: string | null;
	query: string;
	currentPath?: string | null;
	folderPath?: string | null;
	limit?: number;
};

type SearchFileIndexInput = {
	index: IndexedFile[];
	query: string;
	currentPath?: string | null;
	folderPath?: string | null;
	limit?: number;
};

// A file with its display fields and pre-normalized search haystacks computed
// once. Building this per workspace snapshot lets each keystroke skip the
// per-file relativePath/basename/normalize work that dominated search latency
// on large workspaces.
export type IndexedFile = {
	path: string;
	label: string;
	directory: string;
	relativePath: string;
	modifiedAt: number;
	searchFileName: string;
	searchStem: string;
	searchRelativePath: string;
	searchAbsolutePath: string;
};

type ScoredFile = FileSearchResult & {
	score: number;
	currentBoost: number;
};

const defaultResultLimit = 50;

// Build the reusable search index for a workspace snapshot. Recompute only when
// the file list (or workspace root) changes, not on every keystroke.
export function buildFileSearchIndex(
	files: FileEntry[],
	workspacePath: string | null,
): IndexedFile[] {
	const index: IndexedFile[] = [];
	for (const file of files) {
		if (!hasMarkdownExtension(file.path)) continue;
		const relativePath = relativeWorkspacePath(file.path, workspacePath);
		const label = basename(relativePath);
		const extension = extname(label);
		const stem = extension ? label.slice(0, -extension.length) : label;
		index.push({
			path: file.path,
			label,
			directory: directoryFromRelativePath(relativePath),
			relativePath,
			modifiedAt: file.modified_at,
			searchFileName: normalizeSearchText(label),
			searchStem: normalizeSearchText(stem),
			searchRelativePath: normalizeSearchText(relativePath),
			searchAbsolutePath: normalizeSearchText(file.path),
		});
	}
	return index;
}

// Score and rank a prebuilt index against a query. This is the per-keystroke
// hot path, so it only reads precomputed fields — no string normalization.
export function searchFileIndex({
	index,
	query,
	currentPath = null,
	folderPath = null,
	limit = defaultResultLimit,
}: SearchFileIndexInput): FileSearchResult[] {
	const normalizedQuery = normalizeSearchText(query);
	const candidates: ScoredFile[] = [];
	for (const entry of index) {
		if (folderPath && !pathInFolder(entry.path, folderPath)) continue;
		const score = normalizedQuery ? scoreIndexedFile(entry, normalizedQuery) : 1;
		if (score <= 0) continue;
		candidates.push({
			path: entry.path,
			label: entry.label,
			directory: entry.directory,
			relativePath: entry.relativePath,
			modifiedAt: entry.modifiedAt,
			score,
			currentBoost: entry.path === currentPath ? 1 : 0,
		});
	}

	return candidates
		.sort(compareScoredFiles)
		.slice(0, limit)
		.map(({ score: _score, currentBoost: _currentBoost, ...result }) => result);
}

export function searchWorkspaceFiles({
	files,
	workspacePath,
	query,
	currentPath = null,
	folderPath = null,
	limit = defaultResultLimit,
}: SearchWorkspaceFilesInput): FileSearchResult[] {
	return searchFileIndex({
		index: buildFileSearchIndex(files, workspacePath),
		query,
		currentPath,
		folderPath,
		limit,
	});
}

function scoreIndexedFile(entry: IndexedFile, normalizedQuery: string) {
	return Math.max(
		scoreText(entry.searchFileName, normalizedQuery, 100),
		scoreText(entry.searchStem, normalizedQuery, 98),
		scoreText(entry.searchRelativePath, normalizedQuery, 78),
		scoreText(entry.searchAbsolutePath, normalizedQuery, 35),
	);
}

function scoreText(haystack: string, needle: string, exactScore: number) {
	if (!haystack || !needle) return 0;
	if (haystack === needle) return exactScore;
	if (haystack.startsWith(needle)) return exactScore - 10;
	if (startsWithPathWord(haystack, needle)) return exactScore - 16;
	if (haystack.includes(needle)) return exactScore - 28;
	if (isSubsequence(needle, haystack)) return exactScore - 55;
	return 0;
}

function compareScoredFiles(a: ScoredFile, b: ScoredFile) {
	const byScore = b.score - a.score;
	if (byScore !== 0) return byScore;
	const byCurrent = b.currentBoost - a.currentBoost;
	if (byCurrent !== 0) return byCurrent;
	const byModified = b.modifiedAt - a.modifiedAt;
	if (byModified !== 0) return byModified;
	return a.relativePath.localeCompare(b.relativePath);
}

function startsWithPathWord(haystack: string, needle: string) {
	return haystack.split("/").some((part) => part.startsWith(needle));
}

function directoryFromRelativePath(relativePath: string) {
	const index = relativePath.lastIndexOf("/");
	return index >= 0 ? relativePath.slice(0, index) : "";
}

function normalizeSearchText(value: string) {
	return value.toLocaleLowerCase().replace(/[\s_\-./\\]+/g, "");
}

function isSubsequence(needle: string, haystack: string) {
	let index = 0;
	for (const char of haystack) {
		if (char === needle[index]) index += 1;
		if (index === needle.length) return true;
	}
	return false;
}
