/**
 * Wiring between the desktop main process and `@mdly/doc-comments`. Mirrors
 * `docHistoryWiring.ts`'s style: small, unit-testable functions that resolve
 * an absolute file path to a (workspaceRoot, docId) pair and delegate to
 * already-tested `@mdly/doc-comments` functions — `main.ts` only registers
 * IPC handlers and calls these.
 *
 * Comments and revision history share the same per-workspace docId space
 * (via `docHistoryWiring.ts`'s `getHistoryStoreForWorkspace(...).resolveDocId`),
 * so a comment thread survives a file rename the same way a revision log does.
 */

import {
	type CommentThread,
	deleteThread,
	listThreads,
	openThread,
	reopen,
	reply,
	resolve,
	type TextAnchor,
} from "@mdly/doc-comments";
import type { RevisionAuthor } from "@mdly/doc-history";
import { createNodeFileSystem } from "@mdly/doc-history/node";
import {
	getHistoryStoreForWorkspace,
	resolveHistoryWorkspaceRoot,
	toWorkspaceRelativePath,
} from "./docHistoryWiring";

const commentsFileSystem = createNodeFileSystem();

/**
 * The main process has no concept of "the live editor draft" — only the
 * renderer does, and the kit already resolves anchors client-side against it
 * (`EditorView`'s `useCommentThreads`, via `readRevisionContent` + the live
 * draft text). So `listCommentThreadsForPath` below always calls `listThreads`
 * with an empty flattened text and no-op resolution callbacks: the
 * `anchorResolution` field this produces is irrelevant and discarded — the
 * kit's own `CommentThread` type doesn't even carry that field. Only
 * `opener`/`events`/`state`/`id` matter, and `listThreads` computes those
 * correctly regardless of the dummy anchor-resolution inputs.
 */
const NOOP_ANCHOR_RESOLUTION_INPUTS = {
	readRevisionContent: async () => null,
	flattenDocument: (docBody: string) => docBody,
};

/** Resolves the docId for a document at `relativePath`, sharing the same id space as revision history. Exported for unit tests. */
export async function resolveCommentDocId(
	workspaceRoot: string,
	relativePath: string,
): Promise<string> {
	const { id } =
		await getHistoryStoreForWorkspace(workspaceRoot).resolveDocId(relativePath);
	return id;
}

interface ResolvedCommentTarget {
	workspaceRoot: string;
	docId: string;
}

/** Path → workspaceRoot → relativePath → docId, mirroring the same steps `main.ts`'s revision-history handlers already run. Throws if `absoluteFilePath` isn't under any granted root. */
async function resolveCommentTarget(
	absoluteFilePath: string,
	grantedRoots: Iterable<string>,
): Promise<ResolvedCommentTarget> {
	const workspaceRoot = resolveHistoryWorkspaceRoot(
		absoluteFilePath,
		grantedRoots,
	);
	if (!workspaceRoot) {
		throw new Error(
			`No granted workspace root for comment path: ${absoluteFilePath}`,
		);
	}
	const relativePath = toWorkspaceRelativePath(workspaceRoot, absoluteFilePath);
	const docId = await resolveCommentDocId(workspaceRoot, relativePath);
	return { workspaceRoot, docId };
}

export interface OpenCommentThreadForPathParams {
	absoluteFilePath: string;
	grantedRoots: Iterable<string>;
	author: RevisionAuthor;
	anchor: TextAnchor;
	text: string;
}

/** Opens a new comment thread. Rejects on an empty selection/quote (delegated to `@mdly/doc-comments`'s own validation). */
export async function openCommentThreadForPath(
	params: OpenCommentThreadForPathParams,
): Promise<void> {
	const { workspaceRoot, docId } = await resolveCommentTarget(
		params.absoluteFilePath,
		params.grantedRoots,
	);
	await openThread(commentsFileSystem, workspaceRoot, {
		docId,
		author: params.author,
		anchor: params.anchor,
		text: params.text,
	});
}

export interface ReplyToCommentThreadForPathParams {
	absoluteFilePath: string;
	grantedRoots: Iterable<string>;
	author: RevisionAuthor;
	threadId: string;
	text: string;
}

/** Replies to a thread. A reply on a resolved thread reopens it (kept in `@mdly/doc-comments`, not re-implemented here). */
export async function replyToCommentThreadForPath(
	params: ReplyToCommentThreadForPathParams,
): Promise<void> {
	const { workspaceRoot, docId } = await resolveCommentTarget(
		params.absoluteFilePath,
		params.grantedRoots,
	);
	await reply(commentsFileSystem, workspaceRoot, {
		docId,
		threadId: params.threadId,
		author: params.author,
		text: params.text,
	});
}

export interface CommentThreadStateChangeForPathParams {
	absoluteFilePath: string;
	grantedRoots: Iterable<string>;
	author: RevisionAuthor;
	threadId: string;
}

export async function resolveCommentThreadForPath(
	params: CommentThreadStateChangeForPathParams,
): Promise<void> {
	const { workspaceRoot, docId } = await resolveCommentTarget(
		params.absoluteFilePath,
		params.grantedRoots,
	);
	await resolve(commentsFileSystem, workspaceRoot, {
		docId,
		threadId: params.threadId,
		author: params.author,
	});
}

export async function reopenCommentThreadForPath(
	params: CommentThreadStateChangeForPathParams,
): Promise<void> {
	const { workspaceRoot, docId } = await resolveCommentTarget(
		params.absoluteFilePath,
		params.grantedRoots,
	);
	await reopen(commentsFileSystem, workspaceRoot, {
		docId,
		threadId: params.threadId,
		author: params.author,
	});
}

export async function deleteCommentThreadForPath(
	params: CommentThreadStateChangeForPathParams,
): Promise<void> {
	const { workspaceRoot, docId } = await resolveCommentTarget(
		params.absoluteFilePath,
		params.grantedRoots,
	);
	await deleteThread(commentsFileSystem, workspaceRoot, {
		docId,
		threadId: params.threadId,
		author: params.author,
	});
}

export interface ListCommentThreadsForPathResult {
	docId: string;
	threads: CommentThread[];
}

/** Read-only: never appends to a comment log. `docId` is included so the renderer can resolve it without a dedicated IPC channel (folded in here by design). */
export async function listCommentThreadsForPath(
	absoluteFilePath: string,
	grantedRoots: Iterable<string>,
): Promise<ListCommentThreadsForPathResult> {
	const { workspaceRoot, docId } = await resolveCommentTarget(
		absoluteFilePath,
		grantedRoots,
	);
	const threads = await listThreads(
		commentsFileSystem,
		workspaceRoot,
		docId,
		"",
		NOOP_ANCHOR_RESOLUTION_INPUTS,
	);
	return { docId, threads };
}
