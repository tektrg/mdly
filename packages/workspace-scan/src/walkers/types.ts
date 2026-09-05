/** One path a walker could not fully inspect. The walk never aborts on one of
 * these (R15) — it is only reported here, alongside every other file the
 * walk did manage to read. */
export type WalkerErrorEntry = {
	path: string;
	message: string;
};

export type WalkerResult = {
	/** Workspace-relative, POSIX-separated (`/`) paths. */
	files: string[];
	errors: WalkerErrorEntry[];
	/**
	 * Live walk totals (no per-file progress events — the walk itself stays
	 * quiet; the caller derives its indeterminate count-up from `onVisit`).
	 */
	stats?: {
		visitedEntryCount: number;
		visitedDirectoryCount: number;
	};
	/**
	 * Per-file stat snapshot keyed by workspace-relative path, from the
	 * `stat` the walk already performed — lets sync use the mtime/size hint
	 * without a second syscall per file. Absent when the walker was mocked
	 * (callers must fall back to their own stat).
	 */
	details?: Record<string, { size: number; modifiedAt: number }>;
};
