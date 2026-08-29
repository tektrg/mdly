import type { DocHistoryFileSystem } from "@mdly/doc-history";
import {
	appendJsonlLine,
	findJsonlSiblingPaths,
	readMergedJsonlEntries,
} from "@mdly/doc-history";
import { joinPath } from "./paths.js";
import type { AnyCommentEvent, CommentEventKind } from "./types.js";

const COMMENTS_DIR = "comments";

const VALID_KINDS: readonly CommentEventKind[] = [
	"thread-opened",
	"replied",
	"resolved",
	"reopened",
];

export function commentsDirPath(workspaceRoot: string): string {
	return joinPath(workspaceRoot, ".mdly", COMMENTS_DIR);
}

export function commentLogPath(workspaceRoot: string, docId: string): string {
	return joinPath(commentsDirPath(workspaceRoot), `${docId}.jsonl`);
}

/**
 * Appends one JSON line to a document's canonical comment log file (never a fork).
 * Rejects if the event has an unknown kind (R3) — nothing is written on rejection.
 */
export async function appendCommentEvent(
	fs: DocHistoryFileSystem,
	workspaceRoot: string,
	docId: string,
	event: AnyCommentEvent,
): Promise<void> {
	if (!VALID_KINDS.includes(event.kind)) {
		throw new TypeError(
			`Unknown comment event kind: ${event.kind}. Valid kinds: ${VALID_KINDS.join(", ")}`,
		);
	}
	await appendJsonlLine(fs, commentLogPath(workspaceRoot, docId), event);
}

function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds every sibling path for a comment log: the canonical `<docId>.jsonl`,
 * doc-history-style numbered forks (`<docId> 2.jsonl`, ...), AND `.conflict-*`
 * copies. doc-history's own `findJsonlSiblingPaths` does not glob conflict
 * copies (revision logs never produce them the same way), so comments extend
 * it with an explicit conflict-copy glob against the same directory (R6).
 */
export async function findCommentLogSiblings(
	fs: DocHistoryFileSystem,
	workspaceRoot: string,
	docId: string,
): Promise<string[]> {
	const dir = commentsDirPath(workspaceRoot);
	const base = await findJsonlSiblingPaths(fs, dir, docId);

	let names: string[] = [];
	try {
		names = await fs.listDir(dir);
	} catch {
		names = [];
	}
	const conflictPattern = new RegExp(
		`^${escapeForRegExp(docId)}\\.jsonl\\.conflict-.+$`,
	);
	const conflictPaths = names
		.filter((name) => conflictPattern.test(name))
		.map((name) => joinPath(dir, name));

	return [...new Set([...base, ...conflictPaths])];
}

/**
 * Reads all comment events for a document, merging sibling logs and
 * `.conflict-*` copies by event id. Tolerates truncated/non-JSON lines (R6),
 * reusing doc-history's own fork-merge reader verbatim (R7).
 */
export async function readCommentEvents(
	fs: DocHistoryFileSystem,
	workspaceRoot: string,
	docId: string,
): Promise<AnyCommentEvent[]> {
	const paths = await findCommentLogSiblings(fs, workspaceRoot, docId);
	return readMergedJsonlEntries<AnyCommentEvent>(fs, paths);
}
