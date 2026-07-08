// Ported verbatim (pure, no Node deps) from apps/desktop/electron/notion.ts.
// Builds a minimal targeted `update_content` payload for the Notion Markdown
// API, preserving rotated signed file URLs and falling back to a full replace
// only when it is safe to do so.

export type NotionMarkdownUpdatePayload =
	| { kind: "noop"; markdown: string }
	| { kind: "targeted"; oldStr: string; newStr: string }
	| { kind: "replace" };

export function notionMarkdownPatchBody(
	updatePayload: Extract<NotionMarkdownUpdatePayload, { kind: "targeted" }>,
) {
	return {
		type: "update_content" as const,
		update_content: {
			content_updates: [
				{
					old_str: updatePayload.oldStr,
					new_str: updatePayload.newStr,
				},
			],
		},
	};
}

export function notionMarkdownUpdatePayload({
	previousMarkdown,
	currentMarkdown,
	nextMarkdown,
}: {
	previousMarkdown?: string;
	currentMarkdown?: string;
	nextMarkdown: string;
}): NotionMarkdownUpdatePayload {
	if (!previousMarkdown || !currentMarkdown) return { kind: "replace" };

	const nextWithCurrentFileUrls = replaceUnchangedVolatileNotionFileUrls({
		sourceMarkdown: nextMarkdown,
		previousMarkdown,
		currentMarkdown,
	});
	if (nextWithCurrentFileUrls === currentMarkdown) {
		return { kind: "noop", markdown: currentMarkdown };
	}

	const diff = uniqueReplacement(currentMarkdown, nextWithCurrentFileUrls);
	if (diff) {
		return { kind: "targeted", ...diff };
	}

	if (
		hasVolatileNotionFileUrl(previousMarkdown) ||
		hasVolatileNotionFileUrl(currentMarkdown) ||
		hasVolatileNotionFileUrl(nextMarkdown)
	) {
		throw new Error(
			"Cannot safely write back this Notion page because it contains Notion-hosted files with expiring URLs and a minimal targeted update could not be built.",
		);
	}

	return { kind: "replace" };
}

export function shouldFallbackToFullNotionMarkdownUpdate(
	error: unknown,
	{
		previousMarkdown,
		currentMarkdown,
		nextMarkdown,
	}: {
		previousMarkdown?: string;
		currentMarkdown?: string;
		nextMarkdown: string;
	},
): boolean {
	const message = error instanceof Error ? error.message : String(error);
	if (!/\bNo matches found\b/i.test(message)) return false;
	return ![
		previousMarkdown ?? "",
		currentMarkdown ?? "",
		nextMarkdown,
	].some(hasVolatileNotionFileUrl);
}

function replaceUnchangedVolatileNotionFileUrls({
	sourceMarkdown,
	previousMarkdown,
	currentMarkdown,
}: {
	sourceMarkdown: string;
	previousMarkdown: string;
	currentMarkdown: string;
}): string {
	const previousFiles = markdownFileReferences(previousMarkdown);
	const currentFiles = markdownFileReferences(currentMarkdown);
	let next = sourceMarkdown;
	for (let index = 0; index < previousFiles.length; index += 1) {
		const previous = previousFiles[index];
		const current = currentFiles[index];
		if (!previous || !current || previous.url === current.url) continue;
		const previousKey = volatileNotionImageUrlKey(previous.url);
		const currentKey = volatileNotionImageUrlKey(current.url);
		if (!previousKey || previousKey !== currentKey) continue;
		next = next.split(previous.url).join(current.url);
	}
	return next;
}

function uniqueReplacement(
	currentMarkdown: string,
	nextMarkdown: string,
): { oldStr: string; newStr: string } | null {
	const diff = changedRange(currentMarkdown, nextMarkdown);
	if (!diff) return null;

	for (const range of replacementRanges(currentMarkdown, nextMarkdown, diff)) {
		const oldStr = currentMarkdown.slice(range.currentStart, range.currentEnd);
		if (countOccurrences(currentMarkdown, oldStr) !== 1) continue;
		return {
			oldStr,
			newStr: nextMarkdown.slice(range.nextStart, range.nextEnd),
		};
	}

	return null;
}

function changedRange(
	currentMarkdown: string,
	nextMarkdown: string,
): {
	currentStart: number;
	currentEnd: number;
	nextStart: number;
	nextEnd: number;
} | null {
	let prefixLength = 0;
	while (
		prefixLength < currentMarkdown.length &&
		prefixLength < nextMarkdown.length &&
		currentMarkdown[prefixLength] === nextMarkdown[prefixLength]
	) {
		prefixLength += 1;
	}

	let suffixLength = 0;
	while (
		suffixLength < currentMarkdown.length - prefixLength &&
		suffixLength < nextMarkdown.length - prefixLength &&
		currentMarkdown[currentMarkdown.length - 1 - suffixLength] ===
			nextMarkdown[nextMarkdown.length - 1 - suffixLength]
	) {
		suffixLength += 1;
	}

	const currentEnd = currentMarkdown.length - suffixLength;
	if (prefixLength === currentEnd) return null;
	return {
		currentStart: prefixLength,
		currentEnd,
		nextStart: prefixLength,
		nextEnd: nextMarkdown.length - suffixLength,
	};
}

function replacementRanges(
	currentMarkdown: string,
	nextMarkdown: string,
	diff: {
		currentStart: number;
		currentEnd: number;
		nextStart: number;
		nextEnd: number;
	},
) {
	const ranges = [
		diff,
		lineBoundedRange(currentMarkdown, nextMarkdown, diff),
		{
			currentStart: 0,
			currentEnd: currentMarkdown.length,
			nextStart: 0,
			nextEnd: nextMarkdown.length,
		},
	];
	return ranges.filter(
		(range, index) =>
			ranges.findIndex(
				(candidate) =>
					candidate.currentStart === range.currentStart &&
					candidate.currentEnd === range.currentEnd &&
					candidate.nextStart === range.nextStart &&
					candidate.nextEnd === range.nextEnd,
			) === index,
	);
}

function lineBoundedRange(
	currentMarkdown: string,
	nextMarkdown: string,
	diff: {
		currentStart: number;
		currentEnd: number;
		nextStart: number;
		nextEnd: number;
	},
) {
	return {
		currentStart: lineStart(currentMarkdown, diff.currentStart),
		currentEnd: lineEnd(currentMarkdown, diff.currentEnd),
		nextStart: lineStart(nextMarkdown, diff.nextStart),
		nextEnd: lineEnd(nextMarkdown, diff.nextEnd),
	};
}

function lineStart(value: string, index: number): number {
	const previousLineBreak = value.lastIndexOf("\n", Math.max(0, index - 1));
	return previousLineBreak === -1 ? 0 : previousLineBreak + 1;
}

function lineEnd(value: string, index: number): number {
	const nextLineBreak = value.indexOf("\n", index);
	return nextLineBreak === -1 ? value.length : nextLineBreak;
}

function countOccurrences(value: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let index = 0;
	while (true) {
		const nextIndex = value.indexOf(needle, index);
		if (nextIndex === -1) return count;
		count += 1;
		index = nextIndex + needle.length;
	}
}

function markdownFileReferences(markdown: string): { url: string }[] {
	return [
		...markdownImageReferences(markdown),
		...htmlMediaReferences(markdown),
	];
}

function markdownImageReferences(markdown: string): { url: string }[] {
	return [...markdown.matchAll(/!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
		.map((match) => ({ url: match[1] ?? "" }))
		.filter((reference) => reference.url.length > 0);
}

function htmlMediaReferences(markdown: string): { url: string }[] {
	const references: { url: string }[] = [];
	const mediaTags = markdown.matchAll(/<(?:video|source)\b[^>]*>/gi);
	for (const tag of mediaTags) {
		const src = htmlAttributeValue(tag[0], "src");
		if (src) references.push({ url: src });
	}
	return references;
}

function htmlAttributeValue(tag: string, name: string): string | null {
	const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = tag.match(
		new RegExp(
			`\\s${escapedName}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
			"i",
		),
	);
	return match?.[2] ?? match?.[3] ?? match?.[4] ?? null;
}

function hasVolatileNotionFileUrl(markdown: string): boolean {
	return markdownFileReferences(markdown).some((file) =>
		Boolean(volatileNotionImageUrlKey(file.url)),
	);
}

function volatileNotionImageUrlKey(rawUrl: string): string | null {
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
