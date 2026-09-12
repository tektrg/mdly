import { listThreads } from "@mdly/doc-comments";
import type { CommentOptions } from "@mdly/workspace-kit";
import { useStoreValue } from "@simplestack/store/react";
import { useEffect, useMemo, useState } from "react";
import { ensureDeviceId } from "../connection/deviceId";
import { workspaceStore } from "../store/state";
import { deviceLabelFor } from "./deviceLabel";
import { resolveDocIdForPath } from "./docId";
import { createRemoteFileSystem } from "./remoteFileSystem";

/**
 * Web `CommentOptions`, READ-ONLY (Round 7). Mirrors the desktop
 * `DocumentViewer` shape minus every write path:
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
export function useCommentOptions(openPath: string): CommentOptions | undefined {
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
			currentAuthor: {
				kind: "human",
				id: ensureDeviceId(),
				label: deviceLabelFor(navigator.userAgent),
			},
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
			// Step 8 (slot registration) replaces these: rejecting keeps the
			// draft and shows the message inline (composer/panel error slots)
			// instead of silently swallowing text. Never write to the Mac's
			// unsuffixed log — the server would reject it, correctly.
			onOpenThread: async () => {
				throw new Error("Commenting from the web is coming soon.");
			},
			onReply: async () => {
				throw new Error("Replying from the web is coming soon.");
			},
			onResolve: async () => {
				throw new Error("Resolving from the web is coming soon.");
			},
			onReopen: async () => {
				throw new Error("Reopening from the web is coming soon.");
			},
			onDelete: async () => {
				throw new Error("Deleting from the web is coming soon.");
			},
			refreshSignal: workspace.commentsVersion,
		};
	}, [docId, workspace.commentsVersion]);
}
