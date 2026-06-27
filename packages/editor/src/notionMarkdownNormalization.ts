import { normalizeMarkdownTableBoundaries } from "./markdownTableBoundaries.js";
import { normalizeNotionHtmlTables } from "./notionHtmlTable.js";

const NOTION_DIVIDER_LINE = /^[ \t]*---[ \t]*$/;
const FENCE_OPEN_LINE = /^[ \t]{0,3}(`{3,}|~{3,})/;

type FenceState = {
	marker: "`" | "~";
	length: number;
};

export function normalizeNotionMarkdownBody(markdown: string): string {
	const lines = markdown.split("\n");
	const output: string[] = [];
	let fence: FenceState | null = null;

	for (const line of lines) {
		if (fence && closesFence(line, fence)) {
			fence = null;
			output.push(line);
			continue;
		}

		const fenceMatch = FENCE_OPEN_LINE.exec(line);
		if (!fence && fenceMatch) {
			const fenceMarker = fenceMatch[1] ?? "";
			fence = {
				marker: fenceMarker[0] === "~" ? "~" : "`",
				length: fenceMarker.length,
			};
			output.push(line);
			continue;
		}

		if (
			!fence &&
			NOTION_DIVIDER_LINE.test(line) &&
			output.length > 0 &&
			output[output.length - 1]?.trim() !== ""
		) {
			output.push("");
		}
		output.push(line);
	}

	return normalizeMarkdownTableBoundaries(
		normalizeNotionHtmlTables(output.join("\n")),
	);
}

export function hasLinkedNotionFrontMatter(frontMatter: string): boolean {
	const rawMetadata = notionFrontMatterBlock(frontMatter);
	if (!rawMetadata) return false;

	const values = Object.fromEntries(
		rawMetadata.flatMap((line): [string, string][] => {
			const match = /^\s+([a-z_]+):\s*(.*)$/.exec(line);
			if (!match) return [];
			return [[match[1], parseYamlStringValue(match[2])]];
		}),
	);

	return (
		values.object === "page" &&
		values.sync === "linked" &&
		Boolean(values.page_id) &&
		Boolean(values.content_hash)
	);
}

function closesFence(line: string, fence: FenceState): boolean {
	const escapedMarker = fence.marker === "`" ? "`" : "~";
	const pattern = new RegExp(
		`^[ \\t]{0,3}${escapedMarker}{${fence.length},}[ \\t]*$`,
	);
	return pattern.test(line);
}

function notionFrontMatterBlock(frontMatter: string): string[] | null {
	const lines = frontMatter.split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === "notion:");
	if (start === -1) return null;

	const block: string[] = [];
	for (let index = start + 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.trim() !== "" && !/^\s/.test(line)) break;
		block.push(line);
	}
	return block;
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
