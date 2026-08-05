import { compareFiles, type SidebarFile } from "./useSidebarTree";

export const RECENT_FILES_LIMIT = 100;

/** Flattens all files (ignoring folder structure) sorted by last-modified descending, capped to `limit`. */
export function buildRecentFilesList(
	files: SidebarFile[],
	limit: number = RECENT_FILES_LIMIT,
): SidebarFile[] {
	return [...files]
		.sort((a, b) => compareFiles(a, b, "recent"))
		.slice(0, limit);
}
