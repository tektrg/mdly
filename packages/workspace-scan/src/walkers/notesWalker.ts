import path from "node:path";
import { discoverWorkspaceFiles } from "../file-discovery.js";
import {
	isHiddenSidebarFolderName,
	toWorkspaceRelativePath,
} from "./shared.js";
import type { WalkerResult } from "./types.js";

const NOTE_EXTENSION_RE = /\.(md|markdown|mdown)$/i;

/**
 * The cloud-sync "notes" walker (R13): `.md` / `.markdown` / `.mdown` files,
 * under the SAME ignore rules as the Mac app's sidebar — nested
 * `.gitignore` / `.ignore` with Git negation semantics — pruning `.hubble`,
 * `.mdly`, and `*.assets` folders exactly like the sidebar does.
 *
 * Unlike the sidebar, other dot-prefixed folders are no longer blanket
 * skipped: a non-ignored `.something/note.md` now syncs (R14).
 */
export interface NotesWalkerOptions {
	/** Exclusion entries (bare names at any depth, or workspace-anchored paths) pruned on top of the built-in `.hubble`/`.mdly`/`*.assets` rules. */
	excludedFolders?: readonly string[];
	/** Forwarded to `discoverWorkspaceFiles` — throws `WorkspaceTraversalLimitError` past this many visited entries instead of walking an unbounded tree. */
	maxEntries?: number;
	/** Forwarded to `discoverWorkspaceFiles` — throws `WorkspaceDirectoryLimitError` past this many visited directories (the watcher's actual constraint). */
	maxDirectories?: number;
	/** Live walk counts for indeterminate progress — no total exists until the walk ends. */
	onVisit?: (visited: {
		visitedEntryCount: number;
		visitedDirectoryCount: number;
	}) => void;
}

export async function notesWalker(
	workspaceRoot: string,
	options?: NotesWalkerOptions,
): Promise<WalkerResult> {
	const root = path.resolve(workspaceRoot);
	const discovery = await discoverWorkspaceFiles({
		workspaceRoot: root,
		isSupportedFile: (candidatePath) => NOTE_EXTENSION_RE.test(candidatePath),
		isVisibleFolderName: (name) => !isHiddenSidebarFolderName(name),
		alwaysIgnoredDirectoryNames: options?.excludedFolders,
		maxEntries: options?.maxEntries,
		maxDirectories: options?.maxDirectories,
		pruneNestedRepos: true,
		onVisit: options?.onVisit,
	});

	const details: Record<string, { size: number; modifiedAt: number }> = {};
	for (const entry of discovery.files) {
		if (entry.size !== undefined) {
			details[toWorkspaceRelativePath(entry.path, root)] = {
				size: entry.size,
				modifiedAt: entry.modified_at,
			};
		}
	}

	return {
		files: discovery.files
			.map((entry) => toWorkspaceRelativePath(entry.path, root))
			.sort(),
		errors: discovery.errors,
		stats: {
			visitedEntryCount: discovery.stats.visitedEntryCount,
			visitedDirectoryCount: discovery.stats.visitedDirectoryCount,
		},
		details,
	};
}
