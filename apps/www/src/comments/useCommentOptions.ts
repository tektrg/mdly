import { listThreads } from "@mdly/doc-comments";
import type { CommentOptions } from "@mdly/workspace-kit";
import { useStoreValue } from "@simplestack/store/react";
import { useEffect, useMemo, useState } from "react";
import { workspaceStore } from "../store/state";
import {
	deleteCommentThread,
	openCommentThread,
	reopenCommentThread,
	replyToCommentThread,
	resolveCommentThread,
	webAuthor,
} from "./commentActions";
import { resolveDocIdForPath } from "./docId";
import { createRemoteFileSystem } from "./remoteFileSystem";

/**
 * Web `CommentOptions`. Reads mirror the desktop `DocumentViewer` shape;
 * writes go through this browser's slot-suffixed comment log (server Step 8
 * slot registration happens on first write), never the Mac's canonical log:
 * - docId from Round 6's index replay. Unknown path → undefined, so the UI
 *   stays cleanly dark instead of mounting a dead composer.
 * - getThreads reads every device slot through the merged log read, over a
 *   filesystem built from the LIVE store at call time (never a stale
 *   closure) — Mac + phone + phone comments all appear.
 * - getHeadRevisionId / readRevisionContent return null. Deliberate: the
 *   web has no revision store, and null is the contract's "unavailable"
 *   signal, forcing the quote+context anchoring fallback.
 * - refreshSignal is commentsVersion: a websocket arrival repaints threads
 *   without a reload.
 */
export function useCommentOptions(
	openPath: string,
): CommentOptions | undefined {
	const workspace = useStoreValue(workspaceStore);
	const [docId, setDocId] = useState<string | undefined>(undefined);

	useEffect(() => {
		let active = true;
		setDocId(undefined);
		void resolveDocIdForPath(
			openPath,
			workspace.sidecars,
			workspace.commentsVersion,
		).then((resolved) => {
			if (active) setDocId(resolved);
		});
		return () => {
			active = false;
		};
	}, [openPath, workspace.sidecars, workspace.commentsVersion]);

	return useMemo<CommentOptions | undefined>(() => {
		if (!docId) return undefined;
		return {
			currentAuthor: webAuthor(),
			docId,
			getHeadRevisionId: async () => null,
			getThreads: (id) =>
				listThreads(
					createRemoteFileSystem(workspaceStore.get().sidecars),
					"",
					id,
					"",
					{
						readRevisionContent: async () => null,
						flattenDocument: (docBody: string) => docBody,
					},
				),
			readRevisionContent: async () => null,
			// Real writes (web write-back slice 6): each appends one event
			// to this browser's slot-suffixed log and re-lists, so the fresh
			// state in the store is what the withThreadsRefetch wrapper
			// re-reads right after. A failed write rejects — the composer /
			// panel error slots show it inline and keep the draft, never
			// swallowing text.
			onOpenThread: (anchor, text) => openCommentThread(docId, anchor, text),
			onReply: (threadId, text) => replyToCommentThread(docId, threadId, text),
			onResolve: (threadId) => resolveCommentThread(docId, threadId),
			onReopen: (threadId) => reopenCommentThread(docId, threadId),
			onDelete: (threadId) => deleteCommentThread(docId, threadId),
			refreshSignal: workspace.commentsVersion,
		};
	}, [docId, workspace.commentsVersion]);
}
