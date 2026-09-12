import {
	type CommentOptions,
	EditorView,
	type EditorViewProps,
	type WikiTarget,
	wikiDisplayNameForTarget,
} from "@mdly/workspace-kit";
import { useStoreValue } from "@simplestack/store/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { desktopApi } from "../desktopApi";
import { createEmbedExtension } from "../editor/EmbedExtension";
import { handleImageDrop, handleImagePaste } from "../editor/handleImagePaste";
import { IframeView, toAssetUrl } from "../editor/IframeView";
import { createImageExtension } from "../editor/ImageExtension";
import { openOrImportNotionMentionPage } from "../fileActions";
import { hasHtmlExtension, relativeWorkspacePath } from "../lib/filePath";
import { resolveWikiPath } from "../lib/wikiPath";
import { parseNotionDatabaseMetadata } from "../notion/notionDatabase";
import { parseNotionLinkMetadata } from "../notion/notionMarkdown";
import {
	loadPath,
	savePathContent,
	updateEditorContent,
} from "../store/actions";
import { registerEditorDraftFlush } from "../store/editorDraft";
import { observeEditorTransactionStorms } from "../store/editorStormDetector";
import { workspaceStore } from "../store/state";
import { NotionDatabaseViewer } from "./NotionDatabaseViewer";

const HMR_REV = (() => {
	if (!import.meta.hot) return 0;
	const hotData = import.meta.hot.data as { __editorRev?: number };
	hotData.__editorRev = (hotData.__editorRev ?? 0) + 1;
	return hotData.__editorRev;
})();

export function DocumentViewer({
	path,
	content,
	notionDatabaseRefreshToken = 0,
	onScrollContainerChange,
	commentsOpen,
	onCommentsOpenChange,
}: {
	path: string;
	content: string;
	notionDatabaseRefreshToken?: number;
	onScrollContainerChange?: (el: HTMLDivElement | null) => void;
	commentsOpen: boolean;
	onCommentsOpenChange: (open: boolean) => void;
}) {
	if (hasHtmlExtension(path)) {
		return (
			<HtmlDocumentViewer
				key={`${path}:${content}`}
				path={path}
				onScrollContainerChange={onScrollContainerChange}
			/>
		);
	}

	const notionDatabase = parseNotionDatabaseMetadata(content);
	if (notionDatabase) {
		return (
			<NotionDatabaseViewer
				key={`${path}:${notionDatabase.sourceId}`}
				path={path}
				metadata={notionDatabase}
				refreshToken={notionDatabaseRefreshToken}
				onScrollContainerChange={onScrollContainerChange}
			/>
		);
	}

	return (
		<MarkdownEditor
			key={`${path}:${HMR_REV}`}
			path={path}
			initialMarkdown={content}
			onScrollContainerChange={onScrollContainerChange}
			commentsOpen={commentsOpen}
			onCommentsOpenChange={onCommentsOpenChange}
		/>
	);
}

function HtmlDocumentViewer({
	path,
	onScrollContainerChange,
}: {
	path: string;
	onScrollContainerChange?: (el: HTMLDivElement | null) => void;
}) {
	const workspace = useStoreValue(workspaceStore);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		onScrollContainerChange?.(null);
	}, [onScrollContainerChange]);

	return (
		<div className="flex h-full min-h-0 flex-1 overflow-hidden bg-background">
			{error ? (
				<p className="m-0 p-4 text-sm text-destructive">{error}</p>
			) : (
				<IframeView
					className="block min-h-0 flex-1 border-0 bg-card"
					onError={setError}
					src={toAssetUrl(path)}
					style={{ blockSize: "100%", inlineSize: "100%" }}
					title={relativeWorkspacePath(path, workspace.workspacePath)}
					workspacePath={workspace.workspacePath}
				/>
			)}
		</div>
	);
}

function MarkdownEditor({
	path,
	initialMarkdown,
	onScrollContainerChange,
	commentsOpen,
	onCommentsOpenChange,
}: {
	path: string;
	initialMarkdown: string;
	onScrollContainerChange?: (el: HTMLDivElement | null) => void;
	commentsOpen: boolean;
	onCommentsOpenChange: (open: boolean) => void;
}) {
	const workspace = useStoreValue(workspaceStore);
	const notionAccount =
		parseNotionLinkMetadata(initialMarkdown)?.account ?? null;
	const wikiTargets: WikiTarget[] = useMemo(
		() =>
			workspace.files.map((file) => {
				const target = relativeWorkspacePath(
					file.path,
					workspace.workspacePath,
				);
				return {
					path: file.path,
					target,
					title: wikiDisplayNameForTarget(target),
				};
			}),
		[workspace.files, workspace.workspacePath],
	);
	const editorExtensions = useMemo(
		() => [
			createImageExtension(path),
			createEmbedExtension({
				workspacePath: workspace.workspacePath,
				filePath: path,
			}),
		],
		[path, workspace.workspacePath],
	);
	const handlePaste = useCallback<NonNullable<EditorViewProps["onPaste"]>>(
		(editor, event) => handleImagePaste({ editor, event }),
		[],
	);
	const handleDrop = useCallback<NonNullable<EditorViewProps["onDrop"]>>(
		(editor, event) => handleImageDrop({ editor, event }),
		[],
	);
	const openNotionMentionLink = useCallback(
		(href: string) =>
			void openOrImportNotionMentionPage(href, {
				account: notionAccount,
				folderPath: path,
			}),
		[notionAccount, path],
	);
	const openWikiLink = useCallback(
		(target: string) =>
			void loadPath(
				resolveWikiPath({
					target,
					files: workspace.files,
					workspacePath: workspace.workspacePath,
				}),
			),
		[workspace.files, workspace.workspacePath],
	);
	const showEditorMessage = useCallback(
		(message: string, kind: "success" | "error") => {
			if (kind === "success") {
				toast.success(message);
				return;
			}
			toast.error(message);
		},
		[],
	);
	const handleIdleOrForcedCut = useCallback<
		NonNullable<EditorViewProps["onIdleOrForcedCut"]>
	>(
		(cutPath, markdown) =>
			// Both the 3-minute idle timer and the 30-minute-ceiling/file-close
			// forced cut map to the 'idle-session' history cause: the locked
			// revision schema (R3) has no separate 'forced' value, and both are
			// equally an automatic session-boundary capture, distinct from an
			// explicit manual save.
			savePathContent(cutPath, markdown, {
				force: true,
				historyCause: "idle-session",
			}),
		[],
	);
	// Diagnostic: attach the transaction-storm detector to the live editor so a
	// background-OOM loop names its driver on disk. No-ops without the bridge.
	const stormProbeDisposeRef = useRef<(() => void) | null>(null);
	const handleEditorReady = useCallback<
		NonNullable<EditorViewProps["onEditorReady"]>
	>((editor) => {
		stormProbeDisposeRef.current?.();
		stormProbeDisposeRef.current = editor
			? observeEditorTransactionStorms(editor)
			: null;
	}, []);

	// `CommentOptions.docId`/`.currentAuthor` aren't promises, so both must be
	// resolved before `commentOptions` can be built at all -- resolved via one
	// `listCommentThreads` call (folds docId + author identity into a single
	// response instead of two more IPC round-trips). `path` is a stable key
	// here: DocumentViewer remounts this component (via its `key`) on every
	// path change, so this effect only ever runs once per mount. A rejection
	// still resolves `commentIdentity` (see .catch below) so the comment
	// surface mounts into a visible error state (R20) instead of never
	// mounting.
	const [commentIdentity, setCommentIdentity] = useState<{
		docId: string;
		currentAuthor: CommentOptions["currentAuthor"];
	} | null>(null);
	useEffect(() => {
		let active = true;
		desktopApi
			.listCommentThreads(path)
			.then(({ docId, currentAuthor }) => {
				if (active) setCommentIdentity({ docId, currentAuthor });
			})
			.catch((err: unknown) => {
				if (!active) return;
				// R20: an unreadable/EACCES comment log must degrade this
				// document's panel to a visible error, not silently vanish the
				// whole comment surface. `docId`/`currentAuthor` are placeholders
				// -- `getThreads` below re-fetches by `path` regardless and its
				// own rejection is what `useCommentThreads` surfaces as `error`.
				toast.error("Failed to load comment threads", {
					description: err instanceof Error ? err.message : String(err),
				});
				setCommentIdentity({
					docId: path,
					currentAuthor: { kind: "human", id: "unknown" },
				});
			});
		return () => {
			active = false;
		};
	}, [path]);
	// Slice 4: an agent writing a comment through the WebMCP bridge or the local
	// MCP server appends to the log behind this editor's back. `CommentOptions`
	// has always accepted a `refreshSignal` for exactly this, but nothing ever
	// sent one -- so an agent's comment would sit invisible until the document
	// happened to reload for an unrelated reason. The main process now pushes a
	// change event after every agent write; bumping this counter is what makes
	// the panel update live while the user watches.
	const [commentRefreshSignal, setCommentRefreshSignal] = useState(0);
	useEffect(() => {
		return desktopApi.onCommentsChanged((changedPath) => {
			if (changedPath !== path) return;
			setCommentRefreshSignal((signal) => signal + 1);
		});
	}, [path]);
	// Tell the backend which note is open so an agent tool can default to it,
	// and so every agent read can report where the user's attention is. Cleared
	// on unmount: with no editor mounted there is no open document, and a stale
	// value would silently aim an agent's write at a note the user has closed.
	useEffect(() => {
		void desktopApi.setOpenDocumentPath(path);
		return () => {
			void desktopApi.setOpenDocumentPath(null);
		};
	}, [path]);
	const commentOptions = useMemo<CommentOptions | undefined>(() => {
		if (!commentIdentity) return undefined;
		return {
			currentAuthor: commentIdentity.currentAuthor,
			docId: commentIdentity.docId,
			// Resolved fresh at comment time (R10), never cached -- the editor
			// mints new revisions mid-session on its own (idle/forced cuts), so
			// a value snapshotted here would go stale and under-use revision
			// mode for the rest of the session.
			getHeadRevisionId: () =>
				desktopApi
					.getRevisionHistory(path)
					.then((history) =>
						history.length > 0 ? history[history.length - 1].id : null,
					)
					.catch(() => null),
			getThreads: (_docId) =>
				desktopApi.listCommentThreads(path).then((result) => result.threads),
			readRevisionContent: (revisionId) =>
				desktopApi
					.readRevisionContent(path, revisionId)
					.then((result) => (result.status === "ok" ? result.content : null)),
			onOpenThread: (anchor, text) =>
				desktopApi.openCommentThread(path, anchor, text),
			onReply: (threadId, text) =>
				desktopApi.replyToCommentThread(path, threadId, text),
			onResolve: (threadId) => desktopApi.resolveCommentThread(path, threadId),
			onReopen: (threadId) => desktopApi.reopenCommentThread(path, threadId),
			onDelete: (threadId) => desktopApi.deleteCommentThread(path, threadId),
			refreshSignal: commentRefreshSignal,
			panelOpen: commentsOpen,
			onPanelOpenChange: onCommentsOpenChange,
		};
	}, [
		commentIdentity,
		path,
		commentRefreshSignal,
		commentsOpen,
		onCommentsOpenChange,
	]);

	return (
		<EditorView
			path={path}
			initialMarkdown={initialMarkdown}
			wikiTargets={wikiTargets}
			extensions={editorExtensions}
			onPaste={handlePaste}
			onDrop={handleDrop}
			registerDraftFlush={registerEditorDraftFlush}
			onLocalChange={updateEditorContent}
			onSave={savePathContent}
			onIdleOrForcedCut={handleIdleOrForcedCut}
			onScrollContainerChange={onScrollContainerChange}
			onOpenExternalLink={desktopApi.openExternalUrl}
			onOpenNotionMentionLink={openNotionMentionLink}
			onOpenWikiLink={openWikiLink}
			onMessage={showEditorMessage}
			onEditorReady={handleEditorReady}
			commentOptions={commentOptions}
		/>
	);
}
