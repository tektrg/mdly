import type { JSONContent } from "@tiptap/core";
import type { LinkAttrs } from "./Link";
import { wikiDisplayNameForTarget } from "./markdownPath";

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

		default:
			return "";
	}
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
		kind: attrs.kind === "wiki" ? "wiki" : "url",
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

function inlineToMarkdown(nodes: JSONContent[]): string {
	let result = "";
	for (let i = 0; i < nodes.length; ) {
		const attrs = getLinkAttrs(nodes[i]);
		const key = linkKey(attrs);
		if (!attrs || !key) {
			result += nodeToMarkdown(nodes[i]);
			i += 1;
			continue;
		}

		let j = i;
		const grouped: JSONContent[] = [];
		while (j < nodes.length && linkKey(getLinkAttrs(nodes[j])) === key) {
			grouped.push(removeLinkMark(nodes[j]));
			j += 1;
		}
		const text = grouped.map(nodeToMarkdown).join("");
		if (attrs.kind === "wiki") {
			const target = attrs.target || attrs.href;
			const defaultText = wikiDisplayNameForTarget(target);
			result +=
				text === defaultText
					? `[[${target}]]`
					: `[[${target}|${escapeWikiAlias(text)}]]`;
		} else {
			result += `[${text}](${attrs.href})`;
		}
		i = j;
	}
	return result;
}

function inlineToTableMarkdown(nodes: JSONContent[]): string {
	let result = "";
	for (let i = 0; i < nodes.length; ) {
		const attrs = getLinkAttrs(nodes[i]);
		const key = linkKey(attrs);
		if (!attrs || !key) {
			result += nodeToTableMarkdown(nodes[i]);
			i += 1;
			continue;
		}

		let j = i;
		const grouped: JSONContent[] = [];
		while (j < nodes.length && linkKey(getLinkAttrs(nodes[j])) === key) {
			grouped.push(removeLinkMark(nodes[j]));
			j += 1;
		}
		const text = grouped.map(nodeToTableMarkdown).join("");
		if (attrs.kind === "wiki") {
			const target = attrs.target || attrs.href;
			const defaultText = wikiDisplayNameForTarget(target);
			result +=
				text === defaultText
					? `[[${target}]]`
					: `[[${target}|${escapeWikiAlias(text)}]]`;
		} else {
			result += `[${text}](${attrs.href})`;
		}
		i = j;
	}
	return result;
}

function escapeWikiAlias(alias: string) {
	return alias.split("|").join("\\|");
}

function nodeToMarkdown(node: JSONContent): string {
	if (!node.type) return "";

	switch (node.type) {
		case "text": {
			let text = node.text ?? "";

			// Apply marks in the correct order for Markdown
			const marks = node.marks ?? [];

			for (const mark of marks) {
				switch (mark.type) {
					case "code":
						text = `\`${text}\``;
						break;
					case "bold":
						text = `**${text}**`;
						break;
					case "italic":
						text = `*${text}*`;
						break;
					case "strike":
						text = `~~${text}~~`;
						break;
					case "link":
						break;
				}
			}

			return text;
		}

		case "hardBreak": {
			return "  \n"; // Two spaces + newline creates a line break in Markdown
		}

		default:
			return "";
	}
}

function nodeToTableMarkdown(node: JSONContent): string {
	if (!node.type) return "";

	switch (node.type) {
		case "text": {
			const marks = node.marks ?? [];
			if (marks.some((mark) => mark.type === "code")) {
				return `\`${(node.text ?? "").split("|").join("\\|")}\``;
			}

			let text = (node.text ?? "").split("|").join("\\|");
			for (const mark of marks) {
				switch (mark.type) {
					case "bold":
						text = `**${text}**`;
						break;
					case "italic":
						text = `*${text}*`;
						break;
					case "strike":
						text = `~~${text}~~`;
						break;
					case "code":
					case "link":
						break;
				}
			}

			return text;
		}

		case "hardBreak": {
			return "<br>";
		}

		default:
			return "";
	}
}
