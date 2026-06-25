import {
	combineMarkdownFrontMatter,
	parseMarkdownFrontMatter,
} from "@hubble.md/editor";
import type {
	NotionDatabaseQueryResult,
	NotionSearchResult,
} from "../desktopApi/types";

export type NotionDatabaseMetadata = {
	object: "data_source";
	sourceId: string;
	account: string | null;
	url: string | null;
	title: string;
	sync: "read_only";
	pageSize: number;
};

export function buildNotionDatabaseMarkdown({
	result,
	query,
	pageSize,
}: {
	result: NotionSearchResult;
	query: NotionDatabaseQueryResult;
	pageSize: number;
}) {
	const metadata: NotionDatabaseMetadata = {
		object: "data_source",
		sourceId: query.sourceId,
		account: result.account,
		url: result.url,
		title: result.title,
		sync: "read_only",
		pageSize,
	};
	const body = [
		`# ${result.title}`,
		"",
		"> Read-only Notion database. Open this file in Hubble to browse rows with paging.",
		"",
		databaseSnapshotTable(query),
	].join("\n");
	return combineMarkdownFrontMatter(notionDatabaseFrontMatter(metadata), body);
}

export function parseNotionDatabaseMetadata(
	markdown: string,
): NotionDatabaseMetadata | null {
	const parsed = parseMarkdownFrontMatter(markdown);
	if (parsed.type === "none") return null;
	const rawMetadata = notionDatabaseFrontMatterBlock(parsed.raw);
	if (!rawMetadata) return null;

	const values = Object.fromEntries(
		rawMetadata.flatMap((line): [string, string][] => {
			const match = /^\s+([a-z_]+):\s*(.*)$/.exec(line);
			if (!match) return [];
			return [[match[1], parseYamlStringValue(match[2])]];
		}),
	);
	if (values.object !== "data_source" || values.sync !== "read_only") {
		return null;
	}
	if (!values.source_id) return null;

	return {
		object: "data_source",
		sourceId: values.source_id,
		account: values.account || null,
		url: values.url || null,
		title: values.title || "Untitled Notion database",
		sync: "read_only",
		pageSize: positiveInteger(values.page_size) ?? 25,
	};
}

function notionDatabaseFrontMatter(metadata: NotionDatabaseMetadata): string {
	return [
		"notion_database:",
		`  object: ${quoteYaml(metadata.object)}`,
		`  source_id: ${quoteYaml(metadata.sourceId)}`,
		`  account: ${quoteYaml(metadata.account ?? "")}`,
		`  url: ${quoteYaml(metadata.url ?? "")}`,
		`  title: ${quoteYaml(metadata.title)}`,
		'  sync: "read_only"',
		`  page_size: ${metadata.pageSize}`,
	].join("\n");
}

function notionDatabaseFrontMatterBlock(frontMatter: string): string[] | null {
	const lines = frontMatter.split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === "notion_database:");
	if (start === -1) return null;

	const block: string[] = [];
	for (let index = start + 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.trim() !== "" && !/^\s/.test(line)) break;
		block.push(line);
	}
	return block;
}

function databaseSnapshotTable(query: NotionDatabaseQueryResult): string {
	if (query.rows.length === 0) return "_No rows returned._";
	const columns = ["Row", ...query.columns];
	const rows = query.rows.map((row) => [
		row.title || "Untitled",
		...query.columns.map((column) => row.properties[column] ?? ""),
	]);
	return [
		markdownTableRow(columns),
		markdownTableRow(columns.map(() => "---")),
		...rows.map(markdownTableRow),
	].join("\n");
}

function markdownTableRow(cells: string[]): string {
	return `| ${cells.map(markdownTableCell).join(" | ")} |`;
}

function markdownTableCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
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

function positiveInteger(value: string): number | null {
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function quoteYaml(value: string): string {
	return JSON.stringify(value);
}
