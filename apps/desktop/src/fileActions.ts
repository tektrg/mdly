import { desktopApi } from "./desktopApi";
import type { NotionSearchResult } from "./desktopApi/types";
import { dirname } from "./lib/filePath";
import { notionMarkdownContentHash } from "./notion/contentHash";
import { buildNotionDatabaseMarkdown } from "./notion/notionDatabase";
import {
	buildNotionLinkedMarkdown,
	buildNotionLinkedMarkdownFromMetadata,
	parseNotionLinkMetadata,
	stripNotionLinkMetadata,
	uniqueNotionMarkdownPath,
} from "./notion/notionMarkdown";
import {
	createMarkdownFileInFolder,
	loadPath,
	refreshFiles,
	savePathContent,
} from "./store/actions";
import { viewerStore, workspaceStore } from "./store/state";

export type NotionPushResult =
	| { kind: "pushed" }
	| { kind: "remote-changed" }
	| { kind: "not-linked" };

export async function createMarkdownFile() {
	const workspacePath = workspaceStore.get().workspacePath;
	if (!workspacePath) return;
	await createMarkdownFileInFolder(workspacePath);
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
	const filePath = uniqueNotionMarkdownPath({
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
	const filePath = uniqueNotionMarkdownPath({
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
	if (options?.forceRemoteOverwrite !== true) {
		const remote = await desktopApi.getNotionPageMarkdown(
			metadata.pageId,
			metadata.account,
		);
		if (remote.contentHash !== metadata.contentHash) {
			return { kind: "remote-changed" };
		}
	}

	const markdownForNotion = stripNotionLinkMetadata(latestContent);
	const update = await desktopApi.updateNotionPageMarkdown(
		metadata.pageId,
		markdownForNotion,
		metadata.account,
	);
	const nextMarkdown = buildNotionLinkedMarkdownFromMetadata(latestContent, {
		...metadata,
		account: metadata.account ?? update.account,
		contentHash: update.contentHash,
	});
	await desktopApi.writeFileText(current.currentPath, nextMarkdown);
	await loadPath(current.currentPath);
	return { kind: "pushed" };
}

export async function refreshCurrentNotionPage(options?: {
	forceLocalOverwrite?: boolean;
}) {
	const current = viewerStore.get();
	if (!current.currentPath) return false;
	const metadata = parseNotionLinkMetadata(current.content);
	if (!metadata) return false;
	if (
		options?.forceLocalOverwrite !== true &&
		hasLocalChangesSinceLastNotionSync()
	) {
		return false;
	}

	const remote = await desktopApi.getNotionPageMarkdown(
		metadata.pageId,
		metadata.account,
	);
	const nextMarkdown = buildNotionLinkedMarkdownFromMetadata(remote.markdown, {
		...metadata,
		account: metadata.account ?? remote.account,
		contentHash: remote.contentHash,
	});
	await desktopApi.writeFileText(current.currentPath, nextMarkdown);
	await loadPath(current.currentPath);
	await refreshFiles();
	return true;
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
