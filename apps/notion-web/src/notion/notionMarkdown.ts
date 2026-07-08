// Adapted from apps/desktop/src/notion/notionMarkdown.ts.
// Manages the Hubble-owned `notion:` frontmatter block that links a local
// markdown draft to its remote Notion page. File-path helpers from the desktop
// version are omitted — the web app keys drafts by page id, not file path.
import {
	combineMarkdownFrontMatter,
	normalizeNotionMarkdownBody,
	parseMarkdownFrontMatter,
} from "@hubble.md/editor";
import type { NotionSearchResult } from "./types";

type NotionLinkInput = {
	result: Pick<
		NotionSearchResult,
		"id" | "url" | "title" | "lastEditedTime"
	> & { account?: string | null };
	contentHash: string;
};

export type NotionLinkMetadata = {
	object: "page";
	pageId: string;
	account: string | null;
	url: string | null;
	title: string;
	lastEditedTime: string | null;
	contentHash: string;
	sync: "linked";
};

export function buildNotionLinkedMarkdown(
	markdown: string,
	{ result, contentHash }: NotionLinkInput,
): string {
	return buildNotionLinkedMarkdownFromMetadata(markdown, {
		object: "page",
		pageId: result.id,
		account: result.account ?? null,
		url: result.url,
		title: result.title,
		lastEditedTime: result.lastEditedTime,
		contentHash,
		sync: "linked",
	});
}

export function buildNotionLinkedMarkdownFromMetadata(
	markdown: string,
	metadata: NotionLinkMetadata,
): string {
	const parsed = parseMarkdownFrontMatter(markdown);
	const existingFrontMatter = stripNotionFrontMatterBlock(
		parsed.type === "none" ? "" : parsed.raw,
	).trimEnd();
	const notionFrontMatter = notionLinkFrontMatter(metadata);
	return combineMarkdownFrontMatter(
		[existingFrontMatter, notionFrontMatter].filter(Boolean).join("\n"),
		normalizeNotionMarkdownBody(parsed.body),
	);
}

export function parseNotionLinkMetadata(
	markdown: string,
): NotionLinkMetadata | null {
	const parsed = parseMarkdownFrontMatter(markdown);
	if (parsed.type === "none") return null;
	const rawMetadata = notionFrontMatterBlock(parsed.raw);
	if (!rawMetadata) return null;

	const values = Object.fromEntries(
		rawMetadata.flatMap((line): [string, string][] => {
			const match = /^\s+([a-z_]+):\s*(.*)$/.exec(line);
			if (!match) return [];
			return [[match[1] ?? "", parseYamlStringValue(match[2] ?? "")]];
		}),
	);
	if (values.object !== "page" || values.sync !== "linked") return null;
	if (!values.page_id || !values.content_hash) return null;

	return {
		object: "page",
		pageId: values.page_id,
		account: values.account || null,
		url: values.url || null,
		title: values.title || "Untitled Notion page",
		lastEditedTime: values.last_edited_time || null,
		contentHash: values.content_hash,
		sync: "linked",
	};
}

export function stripNotionLinkMetadata(markdown: string): string {
	const parsed = parseMarkdownFrontMatter(markdown);
	if (parsed.type === "none") return markdown;
	return combineMarkdownFrontMatter(
		stripNotionFrontMatterBlock(parsed.raw).trimEnd(),
		normalizeNotionMarkdownBody(parsed.body),
	);
}

export function notionMarkdownBodyForUpdate(markdown: string): string {
	return parseMarkdownFrontMatter(stripNotionLinkMetadata(markdown)).body;
}

function notionLinkFrontMatter(metadata: NotionLinkMetadata): string {
	const lines = [
		"notion:",
		`  object: ${quoteYaml(metadata.object)}`,
		`  page_id: ${quoteYaml(metadata.pageId)}`,
		`  account: ${quoteYaml(metadata.account ?? "")}`,
		`  url: ${quoteYaml(metadata.url ?? "")}`,
		`  title: ${quoteYaml(metadata.title)}`,
		`  last_edited_time: ${quoteYaml(metadata.lastEditedTime ?? "")}`,
		`  content_hash: ${quoteYaml(metadata.contentHash)}`,
		'  sync: "linked"',
	];
	return lines.join("\n");
}

function notionFrontMatterBlock(frontMatter: string): string[] | null {
	const lines = frontMatter.split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === "notion:");
	if (start === -1) return null;

	const block: string[] = [];
	for (let index = start + 1; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (line.trim() !== "" && !/^\s/.test(line)) break;
		block.push(line);
	}
	return block;
}

function stripNotionFrontMatterBlock(frontMatter: string): string {
	const lines = frontMatter.split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === "notion:");
	if (start === -1) return frontMatter;

	let end = start + 1;
	while (end < lines.length) {
		const line = lines[end] ?? "";
		if (line.trim() !== "" && !/^\s/.test(line)) break;
		end += 1;
	}
	return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

function parseYamlStringValue(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		return typeof parsed === "string" ? parsed : String(parsed ?? "");
	} catch {
		return trimmed;
	}
}

function quoteYaml(value: string): string {
	return JSON.stringify(value);
}
