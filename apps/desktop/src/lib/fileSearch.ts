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

type ScoredFile = FileSearchResult & {
	score: number;
	currentBoost: number;
};

const defaultResultLimit = 50;

export function searchWorkspaceFiles({
	files,
	workspacePath,
	query,
	currentPath = null,
	folderPath = null,
	limit = defaultResultLimit,
}: SearchWorkspaceFilesInput): FileSearchResult[] {
	const normalizedQuery = normalizeSearchText(query);
	const candidates = files
		.filter((file) => hasMarkdownExtension(file.path))
		.filter((file) => !folderPath || pathInFolder(file.path, folderPath))
		.map((file): ScoredFile | null => {
			const relativePath = relativeWorkspacePath(file.path, workspacePath);
			const label = basename(relativePath);
			const directory = directoryFromRelativePath(relativePath);
			const score = normalizedQuery
				? scoreFileMatch(
						{ label, relativePath, path: file.path },
						normalizedQuery,
					)
				: 1;
			if (score <= 0) return null;
			return {
				path: file.path,
				label,
				directory,
				relativePath,
				modifiedAt: file.modified_at,
				score,
				currentBoost: file.path === currentPath ? 1 : 0,
			};
		})
		.filter((file): file is ScoredFile => file !== null);

	return candidates
		.sort(compareScoredFiles)
		.slice(0, limit)
		.map(({ score: _score, currentBoost: _currentBoost, ...result }) => result);
}

function scoreFileMatch(
	file: { label: string; relativePath: string; path: string },
	normalizedQuery: string,
) {
	const fileName = normalizeSearchText(file.label);
	const extension = extname(file.label);
	const stem = normalizeSearchText(
		extension ? file.label.slice(0, -extension.length) : file.label,
	);
	const relativePath = normalizeSearchText(file.relativePath);
	const absolutePath = normalizeSearchText(file.path);

	return Math.max(
		scoreText(fileName, normalizedQuery, 100),
		scoreText(stem, normalizedQuery, 98),
		scoreText(relativePath, normalizedQuery, 78),
		scoreText(absolutePath, normalizedQuery, 35),
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
