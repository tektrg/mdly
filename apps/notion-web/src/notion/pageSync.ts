import { parseMarkdownFrontMatter } from "@mdly/workspace-kit";
import {
	getPageMarkdown,
	updatePageMarkdown,
	type UpdatePageResult,
} from "../api/client";
import {
	comparableContentHash,
	hasLocalChanges,
	indexedDbDraftStore as store,
	type Draft,
} from "../store/drafts";
import { notionMarkdownContentHash } from "./contentHash";
import {
	buildNotionLinkedMarkdown,
	notionMarkdownBodyForUpdate,
} from "./notionMarkdown";
import type { NotionSearchResult } from "./types";

export type OpenPageOutcome = {
	draft: Draft;
	/**
	 * refreshed: took the latest remote content (no local edits at risk).
	 * local-preserved: kept local edits; remote was unchanged since last sync.
	 * conflict: kept local edits, but remote also changed since last sync.
	 */
	status: "refreshed" | "local-preserved" | "conflict";
};

function draftTitle(
	result: Pick<NotionSearchResult, "id" | "title" | "url" | "lastEditedTime">,
	fallback: string,
): string {
	return result.title?.trim() || fallback;
}

export async function openPage(
	result: Pick<NotionSearchResult, "id" | "title" | "url" | "lastEditedTime">,
): Promise<OpenPageOutcome> {
	const { markdown: remoteMarkdown } = await getPageMarkdown(result.id);
	const remoteHash = notionMarkdownContentHash(remoteMarkdown);
	const remoteBody = parseMarkdownFrontMatter(remoteMarkdown).body;
	const existing = await store.get(result.id);

	if (existing && hasLocalChanges(existing)) {
		const status =
			existing.syncedContentHash === remoteHash ? "local-preserved" : "conflict";
		return { draft: existing, status };
	}

	const linkedMarkdown = buildNotionLinkedMarkdown(remoteMarkdown, {
		result: { ...result, account: null },
		contentHash: remoteHash,
	});
	const draft: Draft = {
		pageId: result.id,
		title: draftTitle(result, existing?.title ?? "Untitled Notion page"),
		url: result.url,
		markdown: linkedMarkdown,
		syncedBody: remoteBody,
		syncedContentHash: remoteHash,
		updatedAt: Date.now(),
	};
	await store.put(draft);
	return { draft, status: "refreshed" };
}

/** Discard local edits and reload from Notion. */
export async function takeRemote(pageId: string): Promise<Draft> {
	const existing = await store.get(pageId);
	const { markdown: remoteMarkdown } = await getPageMarkdown(pageId);
	const remoteHash = notionMarkdownContentHash(remoteMarkdown);
	const remoteBody = parseMarkdownFrontMatter(remoteMarkdown).body;
	const linkedMarkdown = buildNotionLinkedMarkdown(remoteMarkdown, {
		result: {
			id: pageId,
			title: existing?.title ?? "Untitled Notion page",
			url: existing?.url ?? null,
			lastEditedTime: null,
			account: null,
		},
		contentHash: remoteHash,
	});
	const draft: Draft = {
		pageId,
		title: existing?.title ?? "Untitled Notion page",
		url: existing?.url ?? null,
		markdown: linkedMarkdown,
		syncedBody: remoteBody,
		syncedContentHash: remoteHash,
		updatedAt: Date.now(),
	};
	await store.put(draft);
	return draft;
}

/** Persist an in-progress local edit (no network). */
export async function saveDraft(pageId: string, markdown: string): Promise<Draft> {
	const existing = await store.get(pageId);
	if (!existing) throw new Error("No draft to save for this page.");
	const draft: Draft = { ...existing, markdown, updatedAt: Date.now() };
	await store.put(draft);
	return draft;
}

export async function pushPage(pageId: string): Promise<{
	draft: Draft;
	result: UpdatePageResult;
}> {
	const draft = await store.get(pageId);
	if (!draft) throw new Error("No draft to push for this page.");

	const nextBody = notionMarkdownBodyForUpdate(draft.markdown);
	const result = await updatePageMarkdown(pageId, {
		nextMarkdown: nextBody,
		previousMarkdown: draft.syncedBody,
		currentMarkdown: draft.syncedBody,
	});

	const updated: Draft = {
		...draft,
		syncedBody: nextBody,
		syncedContentHash: comparableContentHash(draft.markdown),
		updatedAt: Date.now(),
	};
	await store.put(updated);
	return { draft: updated, result };
}
