import {
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
}: {
	path: string;
	content: string;
	notionDatabaseRefreshToken?: number;
	onScrollContainerChange?: (el: HTMLDivElement | null) => void;
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
}: {
	path: string;
	initialMarkdown: string;
	onScrollContainerChange?: (el: HTMLDivElement | null) => void;
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
		/>
	);
}
