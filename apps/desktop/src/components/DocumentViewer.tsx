import { wikiDisplayNameForTarget } from "@hubble.md/editor";
import { EditorView, type WikiTarget } from "@hubble.md/ui";
import { useStoreValue } from "@simplestack/store/react";
import { useEffect, useState } from "react";
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
	const wikiTargets: WikiTarget[] = workspace.files.map((file) => {
		const target = relativeWorkspacePath(file.path, workspace.workspacePath);
		return {
			path: file.path,
			target,
			title: wikiDisplayNameForTarget(target),
		};
	});
	return (
		<EditorView
			path={path}
			initialMarkdown={initialMarkdown}
			wikiTargets={wikiTargets}
			extensions={[
				createImageExtension(path),
				createEmbedExtension({
					workspacePath: workspace.workspacePath,
					filePath: path,
				}),
			]}
			onPaste={(editor, event) => handleImagePaste({ editor, event })}
			onDrop={(editor, event) => handleImageDrop({ editor, event })}
			onLocalChange={updateEditorContent}
			onSave={savePathContent}
			onScrollContainerChange={onScrollContainerChange}
			onOpenExternalLink={desktopApi.openExternalUrl}
			onOpenNotionMentionLink={(href) =>
				void openOrImportNotionMentionPage(href, {
					account: notionAccount,
					folderPath: path,
				})
			}
			onOpenWikiLink={(target) =>
				void loadPath(
					resolveWikiPath({
						target,
						files: workspace.files,
						workspacePath: workspace.workspacePath,
					}),
				)
			}
			onMessage={(message, kind) =>
				kind === "success" ? toast.success(message) : toast.error(message)
			}
		/>
	);
}
