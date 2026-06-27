import {
	combineMarkdownFrontMatter,
	normalizeNotionMarkdownBody,
	parseMarkdownFrontMatter,
} from "@hubble.md/editor";

export function normalizeNotionMarkdownForHash(markdown: string): string {
	const parsed = parseMarkdownFrontMatter(markdown);
	if (parsed.type === "none") {
		return normalizeNotionMarkdownBody(
			canonicalizeVolatileNotionFileUrls(canonicalizeNotionCallouts(markdown)),
		);
	}
	return combineMarkdownFrontMatter(
		parsed.raw.trimEnd(),
		normalizeNotionMarkdownBody(
			canonicalizeVolatileNotionFileUrls(
				canonicalizeNotionCallouts(
					canonicalizeFrontMatterBodyBoundary(parsed.body),
				),
			),
		),
	);
}

export function notionMarkdownContentHash(markdown: string): string {
	const normalizedMarkdown = normalizeNotionMarkdownForHash(markdown);
	let hash = 0x811c9dc5;
	for (let index = 0; index < normalizedMarkdown.length; index += 1) {
		hash ^= normalizedMarkdown.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function canonicalizeFrontMatterBodyBoundary(body: string): string {
	return body.replace(/^(?:[ \t]*\r?\n)+/, "");
}

function canonicalizeNotionCallouts(markdown: string): string {
	return markdown.replace(
		/(<callout\b[^>]*>\n?)([\s\S]*?)(\n?<\/callout>)/gi,
		(_match, open: string, body: string, close: string) =>
			`${open}${dedentNotionBlockMarkdown(body)}${close}`,
	);
}

function canonicalizeVolatileNotionFileUrls(markdown: string): string {
	return markdown.replace(
		/!\[([^\]]*)]\(([^)\s]+)(\s+"[^"]*")?\)/g,
		(match, alt: string, rawUrl: string, title: string | undefined) => {
			const canonicalUrl = canonicalNotionFileUrl(rawUrl);
			return canonicalUrl ? `![${alt}](${canonicalUrl}${title ?? ""})` : match;
		},
	);
}

function canonicalNotionFileUrl(rawUrl: string): string | null {
	try {
		const url = new URL(rawUrl);
		const host = url.hostname.toLowerCase();
		if (
			host === "prod-files-secure.s3.us-west-2.amazonaws.com" ||
			host.endsWith(".notion-static.com") ||
			host.endsWith(".notion.site")
		) {
			return `${url.origin}${url.pathname}`;
		}
	} catch {
		return null;
	}
	return null;
}

function dedentNotionBlockMarkdown(markdown: string): string {
	const lines = markdown.split("\n");
	const commonIndent = lines.reduce<string | null>((common, line) => {
		if (line.trim().length === 0) return common;
		const indent = line.match(/^[\t ]*/)?.[0] ?? "";
		if (common === null) return indent;
		let index = 0;
		while (
			index < common.length &&
			index < indent.length &&
			common[index] === indent[index]
		) {
			index += 1;
		}
		return common.slice(0, index);
	}, null);
	if (!commonIndent) return markdown;
	return lines
		.map((line) =>
			line.startsWith(commonIndent) ? line.slice(commonIndent.length) : line,
		)
		.join("\n");
}
