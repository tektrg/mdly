import type { JSONContent } from "@tiptap/core";
import type { LinkAttrs } from "./Link.js";
import { wikiDisplayNameForTarget } from "./markdownPath.js";

/**
 * Convert TipTap JSONContent (ProseMirror document) -> Markdown string
 * This is the reverse of remark-to-prosemirror.ts and runs synchronously.
 */
export function tiptapDocToMarkdown(doc: JSONContent): string {
	if (doc.type !== "doc" || !doc.content) {
		return "";
	}

	const blocks = doc.content.map(blockToMarkdown);
	return blocks.join("\n\n");
}

function blockToMarkdown(node: JSONContent): string {
	if (!node.type) return "";

	switch (node.type) {
		case "paragraph": {
			const content = inlineToMarkdown(node.content ?? []);
			// Empty paragraphs should produce a blank line
			return content || "";
		}

		case "heading": {
			const level = node.attrs?.level ?? 1;
			const content = inlineToMarkdown(node.content ?? []);
			const hashes = "#".repeat(Math.min(Math.max(level, 1), 6));
			return `${hashes} ${content}`;
		}

		case "blockquote": {
			const blockContent = (node.content ?? [])
				.map(blockToMarkdown)
				.filter(Boolean)
				.join("\n\n");
			// Add '> ' prefix to each line
			return blockContent
				.split("\n")
				.map((line) => `> ${line}`)
				.join("\n");
		}

		case "codeBlock": {
			const content =
				node.content
					?.map((child) => (child.type === "text" ? (child.text ?? "") : ""))
					.join("") ?? "";
			const language =
				typeof node.attrs?.language === "string" ? node.attrs.language : "";
			return `\`\`\`${language}\n${content}\n\`\`\``;
		}

		case "mermaidBlock": {
			const raw = typeof node.attrs?.raw === "string" ? node.attrs.raw : "";
			return `\`\`\`mermaid\n${raw}\n\`\`\``;
		}

		case "horizontalRule": {
			return "---";
		}

		case "orderedList": {
			const start = node.attrs?.start ?? 1;
			return (node.content ?? [])
				.map((item, index) => listItemToMarkdown(item, start + index))
				.filter(Boolean)
				.join("\n");
		}

		case "bulletList": {
			return (node.content ?? [])
				.map((item) => listItemToMarkdown(item))
				.filter(Boolean)
				.join("\n");
		}

		case "image": {
			const src = node.attrs?.src ?? "";
			const alt = node.attrs?.alt ?? "";
			if (!src || node.attrs?.uploadId) return "";

			return `![${alt}](${src})`;
		}

		case "table": {
			return tableToMarkdown(node);
		}

		case "embed": {
			const src = String(node.attrs?.src ?? "");
			if (!isValidIframeEmbedSrc(src)) return "";
			return `<iframe src="${escapeHtmlAttr(src)}"></iframe>`;
		}

		case "notionCallout": {
			const attributes = notionCalloutAttributes(node);
			const blockContent = (node.content ?? [])
				.map(blockToMarkdown)
				.filter(Boolean)
				.join("\n\n");
			return `<callout${attributes}>\n${blockContent}\n</callout>`;
		}

		case "notionEmptyBlock": {
			return "<empty-block/>";
		}

		case "notionHtmlBlock": {
			return typeof node.attrs?.raw === "string" ? node.attrs.raw : "";
		}

		default:
			return "";
	}
}

function notionCalloutAttributes(node: JSONContent): string {
	if (
		typeof node.attrs?.rawAttributes === "string" &&
		node.attrs.rawAttributes.trim().length > 0
	) {
		return ` ${node.attrs.rawAttributes.trim()}`;
	}
	if (typeof node.attrs?.icon === "string" && node.attrs.icon.length > 0) {
		return ` icon="${escapeHtmlAttr(node.attrs.icon)}"`;
	}
	return "";
}

function tableToMarkdown(table: JSONContent): string {
	const rows = (table.content ?? []).filter((row) => row.type === "tableRow");
	if (rows.length === 0) return "";

	const columnCount = Math.max(...rows.map((row) => row.content?.length ?? 0));
	if (columnCount === 0) return "";

	const headerCells = cellsForRow(rows[0], columnCount);
	const bodyRows = rows.slice(1).map((row) => cellsForRow(row, columnCount));
	const alignments = headerCells.map((cell) => tableCellAlignment(cell));

	return [
		serializeTableRow(headerCells),
		serializeDelimiterRow(alignments),
		...bodyRows.map(serializeTableRow),
	].join("\n");
}

function cellsForRow(row: JSONContent | undefined, columnCount: number) {
	const cells = row?.content ?? [];
	return Array.from({ length: columnCount }, (_, index) => cells[index]);
}

function tableCellAlignment(cell: JSONContent | undefined): string | null {
	const align = cell?.attrs?.align;
	return align === "left" || align === "right" || align === "center"
		? align
		: null;
}

function serializeTableRow(cells: (JSONContent | undefined)[]): string {
	return `| ${cells.map(tableCellToMarkdown).join(" | ")} |`;
}

function serializeDelimiterRow(alignments: (string | null)[]): string {
	return `| ${alignments.map(alignmentDelimiter).join(" | ")} |`;
}

function alignmentDelimiter(alignment: string | null): string {
	switch (alignment) {
		case "left":
			return ":---";
		case "center":
			return ":---:";
		case "right":
			return "---:";
		default:
			return "---";
	}
}

function tableCellToMarkdown(cell: JSONContent | undefined): string {
	if (!cell) return "";
	const content = (cell.content ?? [])
		.map(tableBlockToMarkdown)
		.filter(Boolean)
		.join("<br>");
	return content.replace(/\r?\n/g, "<br>");
}

function tableBlockToMarkdown(node: JSONContent): string {
	if (node.type === "paragraph") {
		return inlineToTableMarkdown(node.content ?? []);
	}
	return blockToMarkdown(node).split("|").join("\\|");
}

const BLOCKED_IFRAME_SCHEME = /^(file:|data:|javascript:|hubble-asset:)/i;
const LOCAL_IFRAME_SRC = /^(\.{1,2}\/|[^:/\\]+(?:\/|$)).*\.html(?:[?#].*)?$/i;

function isValidIframeEmbedSrc(src: string): boolean {
	if (!src.trim()) return false;
	if (BLOCKED_IFRAME_SCHEME.test(src)) {
		return false;
	}
	if (src.startsWith("/") || src.startsWith("\\") || src.startsWith("//")) {
		return false;
	}
	return LOCAL_IFRAME_SRC.test(src);
}

function escapeHtmlAttr(value: string) {
	return value
		.split("&")
		.join("&amp;")
		.split('"')
		.join("&quot;")
		.split("<")
		.join("&lt;");
}

function getLinkAttrs(node: JSONContent | undefined): LinkAttrs | null {
	if (!node?.marks) return null;
	const linkMark = node.marks.find((mark) => mark.type === "link");
	if (!linkMark) return null;
	const attrs = linkMark.attrs as
		| { href?: unknown; kind?: unknown; target?: unknown }
		| undefined;
	if (typeof attrs?.href !== "string") return null;
	return {
		href: attrs.href,
		kind:
			attrs.kind === "wiki" || attrs.kind === "notionMention"
				? attrs.kind
				: "url",
		target: typeof attrs.target === "string" ? attrs.target : null,
	};
}

function linkKey(attrs: LinkAttrs | null) {
	if (!attrs) return null;
	return `${attrs.kind}\u0000${attrs.href}\u0000${attrs.target ?? ""}`;
}

function removeLinkMark(node: JSONContent): JSONContent {
	if (!node.marks) return node;
	return {
		...node,
		marks: node.marks.filter((mark) => mark.type !== "link"),
	};
}

function listItemToMarkdown(item: JSONContent, number?: number): string {
	if (item.type !== "listItem") return "";

	const isBullet = number === undefined;
	const content = (item.content ?? [])
		.map((node, index) => {
			if (index === 0 && node.type === "paragraph") {
				// First paragraph content goes inline with the bullet/number or checkbox
				return inlineToMarkdown(node.content ?? []);
			}
			// Additional blocks are indented
			return blockToMarkdown(node)
				.split("\n")
				.map((line) => `  ${line}`)
				.join("\n");
		})
		.filter(Boolean)
		.join("\n");

	// If this is a bullet item and it has a checked attribute (true/false), render as a task item
	const hasCheckedAttr = item.attrs && "checked" in item.attrs;
	const checked = hasCheckedAttr ? item.attrs?.checked : null;

	if (isBullet && checked !== null && checked !== undefined) {
		const checkbox = checked ? "[x]" : "[ ]";
		return `- ${checkbox} ${content}`;
	}

	const prefix = isBullet ? "-" : `${number}.`;
	return `${prefix} ${content}`;
}

/** Marks that wrap a run of neighbouring inline nodes, outermost first. */
const RUN_MARKS = [
	{ type: "bold", delimiter: "**" },
	{ type: "italic", delimiter: "*" },
	{ type: "strike", delimiter: "~~" },
] as const;

function markTypesOf(node: JSONContent): Set<string> {
	const types = new Set<string>();
	for (const mark of node.marks ?? []) {
		if (mark.type) types.add(mark.type);
	}
	return types;
}

/**
 * `** bold **` is not bold — CommonMark rejects a delimiter run that hugs
 * whitespace — so push any edge whitespace outside the pair.
 */
function wrapDelimited(text: string, delimiter: string): string {
	const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
	if (!match) return text;
	const [, leading, core, trailing] = match;
	if (!core) return text;
	return `${leading}${delimiter}${core}${delimiter}${trailing}`;
}

/**
 * Serialize a run of inline nodes, emitting each formatting delimiter ONCE
 * around the longest stretch of neighbours that shares it.
 *
 * TipTap splits a bold sentence containing inline code into three text nodes
 * ("Rule: run " / "realpath" / " on the file"). Wrapping each node on its own
 * closes and immediately reopens the bold pair at every seam, and the `****`
 * that produces is not a valid delimiter run — CommonMark renders it as
 * literal asterisks. Grouping first is what keeps ``**a `b` c**`` intact.
 *
 * Links are grouped the same way, but rank below the formatting marks so bold
 * that runs past a link still emits one pair around the whole span.
 */
function runToMarkdown(
	nodes: JSONContent[],
	leafToMarkdown: (node: JSONContent) => string,
	applied: ReadonlySet<string> = new Set(),
): string {
	let result = "";
	for (let i = 0; i < nodes.length; ) {
		const types = markTypesOf(nodes[i]);
		const runMark = RUN_MARKS.find(
			(candidate) => types.has(candidate.type) && !applied.has(candidate.type),
		);

		if (runMark) {
			let end = i + 1;
			while (end < nodes.length && markTypesOf(nodes[end]).has(runMark.type)) {
				end += 1;
			}
			const inner = runToMarkdown(
				nodes.slice(i, end),
				leafToMarkdown,
				new Set([...applied, runMark.type]),
			);
			result += wrapDelimited(inner, runMark.delimiter);
			i = end;
			continue;
		}

		const attrs = getLinkAttrs(nodes[i]);
		const key = linkKey(attrs);
		if (attrs && key) {
			let end = i;
			const grouped: JSONContent[] = [];
			while (end < nodes.length && linkKey(getLinkAttrs(nodes[end])) === key) {
				grouped.push(removeLinkMark(nodes[end]));
				end += 1;
			}
			result += linkToMarkdown(
				attrs,
				runToMarkdown(grouped, leafToMarkdown, applied),
			);
			i = end;
			continue;
		}

		result += leafToMarkdown(nodes[i]);
		i += 1;
	}
	return result;
}

function escapeWikiAlias(alias: string) {
	return alias.split("|").join("\\|");
}

function linkToMarkdown(attrs: LinkAttrs, text: string): string {
	if (attrs.kind === "notionMention") {
		return `<mention-page url="${escapeHtmlAttr(attrs.href)}"/>`;
	}
	if (attrs.kind === "wiki") {
		const target = attrs.target || attrs.href;
		const defaultText = wikiDisplayNameForTarget(target);
		return text === defaultText
			? `[[${target}]]`
			: `[[${target}|${escapeWikiAlias(text)}]]`;
	}
	return `[${text}](${attrs.href})`;
}

function inlineToMarkdown(nodes: JSONContent[]): string {
	return runToMarkdown(nodes, leafToMarkdown);
}

function inlineToTableMarkdown(nodes: JSONContent[]): string {
	return runToMarkdown(nodes, leafToTableMarkdown);
}

/**
 * One inline node once every run-level mark is already open around it. Only
 * `code` is left, and it is always innermost: ``**`x`**`` is bold code, while
 * `` `**x**` `` is a code span with two literal asterisks in it.
 */
function leafToMarkdown(node: JSONContent): string {
	switch (node.type) {
		case "text": {
			const text = node.text ?? "";
			return markTypesOf(node).has("code") ? `\`${text}\`` : text;
		}

		case "hardBreak": {
			return "  \n"; // Two spaces + newline creates a line break in Markdown
		}

		default:
			return "";
	}
}

function leafToTableMarkdown(node: JSONContent): string {
	switch (node.type) {
		case "text": {
			const text = (node.text ?? "").split("|").join("\\|");
			return markTypesOf(node).has("code") ? `\`${text}\`` : text;
		}

		case "hardBreak": {
			return "<br>";
		}

		default:
			return "";
	}
}
