import {
	combineMarkdownFrontMatter,
	normalizeNotionMarkdownBody,
	parseMarkdownFrontMatter,
} from "@mdly/workspace-kit/engine";

export type DocSourceMetadata = {
	object: "document";
	kind: string;
	origin: "url" | "file";
	url: string | null;
	path: string | null;
	title: string;
	importedAt: string;
	contentHash: string;
	converter: string;
	sync: "imported";
};

export type DocSourceInput = {
	kind: string;
	origin: "url" | "file";
	url?: string | null;
	path?: string | null;
	title: string;
	importedAt: string;
	contentHash: string;
	converter: string;
};

export function buildDocSourceMarkdown(
	markdown: string,
	source: DocSourceInput,
): string {
	return buildDocSourceMarkdownFromMetadata(markdown, {
		object: "document",
		kind: source.kind,
		origin: source.origin,
		url: source.url ?? null,
		path: source.path ?? null,
		title: source.title,
		importedAt: source.importedAt,
		contentHash: source.contentHash,
		converter: source.converter,
		sync: "imported",
	});
}

export function buildDocSourceMarkdownFromMetadata(
	markdown: string,
	metadata: DocSourceMetadata,
): string {
	const parsed = parseMarkdownFrontMatter(markdown);
	const existingFrontMatter = stripDocSourceBlock(parsed.type === "none" ? "" : parsed.raw).trimEnd();
	const sourceFrontMatter = docSourceFrontMatter(metadata);
	return combineMarkdownFrontMatter(
		[existingFrontMatter, sourceFrontMatter].filter(Boolean).join("\n"),
		normalizeNotionMarkdownBody(parsed.body),
	);
}

export function parseDocSourceMetadata(
	markdown: string,
): DocSourceMetadata | null {
	const parsed = parseMarkdownFrontMatter(markdown);
	if (parsed.type === "none") return null;
	const rawMetadata = docSourceBlock(parsed.raw);
	if (!rawMetadata) return null;

	const values = Object.fromEntries(
		rawMetadata.flatMap((line): [string, string][] => {
			const match = /^\s+([a-z_]+):\s*(.*)$/.exec(line);
			if (!match) return [];
			return [[match[1], parseYamlStringValue(match[2])]];
		}),
	);
	if (values.object !== "document" || values.sync !== "imported") return null;
	if (!values.content_hash) return null;

	return {
		object: "document",
		kind: values.kind || "unknown",
		origin: values.origin === "url" ? "url" : "file",
		url: values.url || null,
		path: values.path || null,
		title: values.title || "Untitled document",
		importedAt: values.imported_at || "",
		contentHash: values.content_hash,
		converter: values.converter || "",
		sync: "imported",
	};
}

export function stripDocSourceMetadata(markdown: string): string {
	const parsed = parseMarkdownFrontMatter(markdown);
	if (parsed.type === "none") return markdown;
	return combineMarkdownFrontMatter(
		stripDocSourceBlock(parsed.raw).trimEnd(),
		normalizeNotionMarkdownBody(parsed.body),
	);
}

function docSourceFrontMatter(metadata: DocSourceMetadata): string {
	const lines = [
		"source:",
		`  object: ${quoteYaml(metadata.object)}`,
		`  kind: ${quoteYaml(metadata.kind)}`,
		`  origin: ${quoteYaml(metadata.origin)}`,
		`  url: ${quoteYaml(metadata.url ?? "")}`,
		`  path: ${quoteYaml(metadata.path ?? "")}`,
		`  title: ${quoteYaml(metadata.title)}`,
		`  imported_at: ${quoteYaml(metadata.importedAt)}`,
		`  content_hash: ${quoteYaml(metadata.contentHash)}`,
		`  converter: ${quoteYaml(metadata.converter)}`,
		'  sync: "imported"',
	];
	return lines.join("\n");
}

function docSourceBlock(frontMatter: string): string[] | null {
	const lines = frontMatter.split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === "source:");
	if (start === -1) return null;

	const block: string[] = [];
	for (let index = start + 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.trim() !== "" && !/^\s/.test(line)) break;
		block.push(line);
	}
	return block;
}

function stripDocSourceBlock(frontMatter: string): string {
	const lines = frontMatter.split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === "source:");
	if (start === -1) return frontMatter;

	let end = start + 1;
	while (end < lines.length) {
		const line = lines[end];
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