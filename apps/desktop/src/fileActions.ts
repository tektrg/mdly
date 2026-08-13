import {
	combineMarkdownFrontMatter,
	markdownToTiptapDoc,
	parseMarkdownFrontMatter,
	tiptapDocToMarkdown,
} from "@mdly/workspace-kit/engine";
import { desktopApi } from "./desktopApi";
import type { DocImportResult, NotionSearchResult } from "./desktopApi/types";
import { dirname } from "./lib/filePath";
import { notionMarkdownContentHash } from "./notion/contentHash";
import { buildDocSourceMarkdown } from "./docImport/docSourceMarkdown";
import { buildNotionDatabaseMarkdown } from "./notion/notionDatabase";
import {
	buildNotionLinkedMarkdown,
	buildNotionLinkedMarkdownFromMetadata,
	notionMarkdownBodyForUpdate,
	parseNotionLinkMetadata,
	stripNotionLinkMetadata,
	uniqueMarkdownPath,
} from "./notion/notionMarkdown";
import {
	createMarkdownFileInFolder,
	loadPath,
	refreshFiles,
	savePathContent,
} from "./store/actions";
import { flushEditorDraft } from "./store/editorDraft";
import { getBaseline, viewerStore, workspaceStore } from "./store/state";

export type NotionPushResult =
	| { kind: "pushed" }
	| { kind: "remote-changed" }
	| { kind: "not-linked" };

export type NotionRefreshResult =
	| { kind: "refreshed" }
	| { kind: "local-changes" }
	| { kind: "not-linked" };

export async function createMarkdownFile() {
	const workspacePath = workspaceStore.get().workspacePath;
	if (!workspacePath) return;
	await createMarkdownFileInFolder(workspacePath);
}

export async function importDocFile(filePath: string): Promise<string | null> {
	const result = await desktopApi.docImportConvert(filePath);
	return landDocImport(result, {
		origin: "file",
		url: null,
		path: filePath,
	});
}

export async function importDocUrl(url: string): Promise<string | null> {
	const result = await desktopApi.docImportConvertUrl(url);
	return landDocImport(result, {
		origin: "url",
		url,
		path: null,
	});
}

async function landDocImport(
	result: DocImportResult,
	source: { origin: "url" | "file"; url: string | null; path: string | null },
): Promise<string | null> {
	const workspace = workspaceStore.get();
	if (!workspace.workspacePath) return null;

	const folderPath = activeFolderPath(workspace.workspacePath, null);
	const markdownPath = uniqueMarkdownPath({
		folderPath,
		title: result.title,
		existingPaths: workspace.files.map((file) => file.path),
		fallbackFileName: "imported-document",
	});
	const markdown = buildDocSourceMarkdown(result.markdown, {
		kind: result.kind,
		origin: source.origin,
		url: source.url,
		path: source.path,
		title: result.title,
		importedAt: new Date().toISOString(),
		contentHash: result.contentHash,
		converter: "anydoc",
	});

	await desktopApi.writeFileText(markdownPath, markdown);
	await refreshFiles();
	await loadPath(markdownPath);
	return markdownPath;
}

export async function importNotionPage(
	result: NotionSearchResult,
	options?: { folderPath?: string | null },
) {
	if (result.object !== "page") return null;
	return createNotionPageFile(result, options);
}

export async function openOrImportNotionPage(
	result: NotionSearchResult,
	options?: { folderPath?: string | null },
) {
	if (result.object !== "page") return null;
	const existingPath = await linkedNotionPagePath(result.id, result.account);
	if (existingPath) {
		await loadPath(existingPath);
		return existingPath;
	}
	return createNotionPageFile(result, options);
}

export async function openOrImportNotionMentionPage(
	url: string,
	options?: { account?: string | null; folderPath?: string | null },
) {
	const pageId = notionPageIdFromUrl(url);
	if (!pageId) {
		await desktopApi.openExternalUrl(url);
		return null;
	}
	return openOrImportNotionPage(
		{
			id: pageId,
			object: "page",
			account: options?.account ?? null,
			title: notionMentionTitle(pageId),
			url,
			lastEditedTime: null,
		},
		{ folderPath: options?.folderPath ?? null },
	);
}

export async function importNotionDatabase(
	result: NotionSearchResult,
	options?: { folderPath?: string | null },
) {
	if (result.object === "page") return null;
	const workspace = workspaceStore.get();
	if (!workspace.workspacePath) return null;

	const pageSize = 25;
	const query = await desktopApi.queryNotionDatabase({
		sourceId: result.id,
		sourceObject: result.object,
		account: result.account,
		pageSize,
	});
	const folderPath = activeFolderPath(
		workspace.workspacePath,
		options?.folderPath ?? null,
	);
	const filePath = uniqueMarkdownPath({
		folderPath,
		title: `${result.title} database`,
		existingPaths: workspace.files.map((file) => file.path),
	});
	const markdown = buildNotionDatabaseMarkdown({
		result,
		query,
		pageSize,
	});

	await desktopApi.writeFileText(filePath, markdown);
	await refreshFiles();
	await loadPath(filePath);
	return filePath;
}

async function createNotionPageFile(
	result: NotionSearchResult,
	options?: { folderPath?: string | null },
) {
	const workspace = workspaceStore.get();
	if (!workspace.workspacePath) return null;

	const page = await desktopApi.getNotionPageMarkdown(
		result.id,
		result.account,
	);
	const linkedResult = {
		...result,
		account: result.account ?? page.account,
	};
	const folderPath = activeFolderPath(
		workspace.workspacePath,
		options?.folderPath ?? null,
	);
	const filePath = uniqueMarkdownPath({
		folderPath,
		title: result.title,
		existingPaths: workspace.files.map((file) => file.path),
	});
	const markdown = buildNotionLinkedMarkdown(page.markdown, {
		result: linkedResult,
		contentHash: page.contentHash,
	});

	await desktopApi.writeFileText(filePath, markdown);
	await refreshFiles();
	await loadPath(filePath);
	return filePath;
}

async function linkedNotionPagePath(
	pageId: string,
	account: string | null,
): Promise<string | null> {
	for (const file of workspaceStore.get().files) {
		try {
			const markdown = await desktopApi.readFileText(file.path);
			const metadata = parseNotionLinkMetadata(markdown);
			if (!metadata || metadata.pageId !== pageId) continue;
			if (account && metadata.account && account !== metadata.account) continue;
			return file.path;
		} catch {
			// Ignore unreadable stale entries; refreshFiles will clean them up later.
		}
	}
	return null;
}

export function currentNotionLinkStatus() {
	const current = viewerStore.get();
	return current.currentPath ? parseNotionLinkMetadata(current.content) : null;
}

export function hasLocalChangesSinceLastNotionSync() {
	flushEditorDraft();
	const current = viewerStore.get();
	const metadata = parseNotionLinkMetadata(current.content);
	if (!metadata) return false;
	return (
		notionMarkdownContentHash(stripNotionLinkMetadata(current.content)) !==
		metadata.contentHash
	);
}

export async function pushCurrentNotionPage(options?: {
	forceRemoteOverwrite?: boolean;
}): Promise<NotionPushResult> {
	flushEditorDraft();
	const current = viewerStore.get();
	if (!current.currentPath) return { kind: "not-linked" };
	const metadata = parseNotionLinkMetadata(current.content);
	if (!metadata) return { kind: "not-linked" };

	await savePathContent(current.currentPath, current.content, { force: true });
	const latest = viewerStore.get();
	const latestContent =
		latest.currentPath === current.currentPath
			? latest.content
			: current.content;
	const remoteBeforeUpdate = await desktopApi.getNotionPageMarkdown(
		metadata.pageId,
		metadata.account,
	);
	if (
		options?.forceRemoteOverwrite !== true &&
		remoteBeforeUpdate.contentHash !== metadata.contentHash
	) {
		return { kind: "remote-changed" };
	}

	const markdownForNotion = notionMarkdownBodyForUpdate(latestContent);
	const previousMarkdownForNotion = notionMarkdownBodyForUpdate(
		getBaseline(current),
	);
	const currentMarkdownForNotion = notionMarkdownBodyForUpdate(
		remoteBeforeUpdate.markdown,
	);
	const update = await desktopApi.updateNotionPageMarkdown(
		metadata.pageId,
		markdownForNotion,
		metadata.account,
		{
			previousMarkdown: previousMarkdownForNotion,
			currentMarkdown: currentMarkdownForNotion,
		},
	);
	const remote = await desktopApi.getNotionPageMarkdown(
		metadata.pageId,
		metadata.account ?? update.account,
	);
	const nextMarkdown = buildNotionLinkedMarkdownFromMetadata(remote.markdown, {
		...metadata,
		account: metadata.account ?? update.account ?? remote.account,
		contentHash: remote.contentHash,
	});
	await desktopApi.writeFileText(current.currentPath, nextMarkdown);
	await loadPath(current.currentPath);
	return { kind: "pushed" };
}

export async function refreshCurrentNotionPage(options?: {
	forceLocalOverwrite?: boolean;
}): Promise<NotionRefreshResult> {
	flushEditorDraft();
	const current = viewerStore.get();
	if (!current.currentPath) return { kind: "not-linked" };
	const metadata = parseNotionLinkMetadata(current.content);
	if (!metadata) return { kind: "not-linked" };

	const remote = await desktopApi.getNotionPageMarkdown(
		metadata.pageId,
		metadata.account,
	);
	const currentMarkdown = stripNotionLinkMetadata(current.content);
	const localMarkdownForRefresh = localMarkdownForRefreshCheck(current.content);
	const localContentHash = notionMarkdownContentHash(localMarkdownForRefresh);
	const localMatchesFetchedRemote =
		metadata.contentHash === remote.contentHash &&
		isEditorOnlyNotionNormalization({
			baselineMarkdown: remote.markdown,
			currentMarkdown,
			requireSameImageReferences: false,
		});
	if (
		options?.forceLocalOverwrite !== true &&
		localContentHash !== metadata.contentHash &&
		localContentHash !== remote.contentHash &&
		!localMatchesFetchedRemote
	) {
		return { kind: "local-changes" };
	}
	const nextMarkdown = buildNotionLinkedMarkdownFromMetadata(remote.markdown, {
		...metadata,
		account: metadata.account ?? remote.account,
		contentHash: remote.contentHash,
	});
	if (
		nextMarkdown === current.content &&
		nextMarkdown === getBaseline(current)
	) {
		return { kind: "refreshed" };
	}
	await desktopApi.writeFileText(current.currentPath, nextMarkdown);
	await loadPath(current.currentPath);
	await refreshFiles();
	return { kind: "refreshed" };
}

function localMarkdownForRefreshCheck(currentContent: string): string {
	const current = viewerStore.get();
	const currentMarkdown = stripNotionLinkMetadata(currentContent);
	const baseline = getBaseline(current);
	const baselineMarkdown = stripNotionLinkMetadata(baseline);
	if (
		currentContent !== baseline &&
		isEditorOnlyNotionNormalization({
			baselineMarkdown,
			currentMarkdown,
		})
	) {
		return baselineMarkdown;
	}
	return currentMarkdown;
}

function isEditorOnlyNotionNormalization({
	baselineMarkdown,
	currentMarkdown,
	requireSameImageReferences = true,
}: {
	baselineMarkdown: string;
	currentMarkdown: string;
	requireSameImageReferences?: boolean;
}): boolean {
	if (
		requireSameImageReferences &&
		!sameMarkdownImageReferences(baselineMarkdown, currentMarkdown)
	) {
		return false;
	}
	return editorCanonicalMarkdownVariants(baselineMarkdown).includes(
		currentMarkdown,
	);
}

function editorCanonicalMarkdownVariants(markdown: string): string[] {
	let current = markdown;
	const variants: string[] = [];
	for (let index = 0; index < 4; index += 1) {
		const parsed = parseMarkdownFrontMatter(current);
		const body = tiptapDocToMarkdown(markdownToTiptapDoc(parsed.body));
		const next =
			parsed.type === "none"
				? body
				: combineMarkdownFrontMatter(parsed.raw, body);
		variants.push(next);
		if (next === current) return variants;
		current = next;
	}
	return variants;
}

function sameMarkdownImageReferences(left: string, right: string): boolean {
	return (
		markdownImageReferences(left).join("\u0000") ===
		markdownImageReferences(right).join("\u0000")
	);
}

function markdownImageReferences(markdown: string): string[] {
	return [...markdown.matchAll(/!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(
		(match) => match[1] ?? "",
	);
}

function activeFolderPath(
	workspacePath: string,
	preferredPath: string | null,
): string {
	const targetPath = preferredPath ?? viewerStore.get().currentPath;
	if (!targetPath || targetPath === workspacePath) return workspacePath;
	if (
		workspaceStore.get().folders.some((folder) => folder.path === targetPath)
	) {
		return targetPath;
	}
	return dirname(targetPath) ?? workspacePath;
}

export function notionPageIdFromUrl(url: string): string | null {
	try {
		const parsedUrl = new URL(url);
		const segments = parsedUrl.pathname.split("/").filter(Boolean);
		for (let index = segments.length - 1; index >= 0; index -= 1) {
			const pageId = normalizedNotionPageId(segments[index] ?? "");
			if (pageId) return pageId;
		}
	} catch {
		return normalizedNotionPageId(url);
	}
	return null;
}

function normalizedNotionPageId(value: string): string | null {
	const decoded = decodeURIComponent(value);
	const match = decoded.replace(/-/g, "").match(/([0-9a-f]{32})(?:[?#].*)?$/i);
	return match?.[1]?.toLowerCase() ?? null;
}

function notionMentionTitle(pageId: string): string {
	return `Notion page ${pageId.slice(0, 8)}`;
}
