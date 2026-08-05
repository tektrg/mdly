import type { JSONContent } from "@tiptap/core";
import type {
	Element as HastElement,
	Root as HastRoot,
	RootContent,
} from "hast";
import { fromHtml } from "hast-util-from-html";
import type {
	AlignType,
	Content,
	Image,
	List,
	ListItem,
	Paragraph,
	Root,
	Table,
	TableCell,
	TableRow,
} from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { type Plugin, unified } from "unified";
import { visit } from "unist-util-visit";
import { wikiDisplayNameForTarget } from "./markdownPath.js";
import { normalizeMarkdownTableBoundaries } from "./markdownTableBoundaries.js";
import {
	normalizeNotionHtmlTables,
	notionHtmlTableToMarkdown,
} from "./notionHtmlTable.js";

// Convert Markdown (string) -> TipTap JSONContent (ProseMirror document)
export function markdownToTiptapDoc(markdown: string): JSONContent {
	const input = rawMarkdownAddEmptyMarkers(
		separateHtmlBlocksFromFollowingMarkdown(
			normalizeMarkdownTableBoundaries(normalizeNotionHtmlTables(markdown)),
		),
	);
	const processor = unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkRemoveEmptyMarkers);
	const parsed = processor.parse(input);
	const tree = processor.runSync(parsed) as Root;
	return {
		type: "doc",
		content: normalizeBlockContent(tree.children).flatMap(blockToPM),
	} satisfies JSONContent;
}

function normalizeBlockContent(children: Content[]): Content[] {
	// mdast root.children are already block-level. Return as-is for now.
	return children;
}

function separateHtmlBlocksFromFollowingMarkdown(markdown: string): string {
	const lines = markdown.split("\n");
	const output: string[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const nextLine = lines[index + 1];
		const isStandaloneEmptyBlock = line.match(/^<empty-block\s*\/>\s*$/i);
		if (
			isStandaloneEmptyBlock &&
			output.length > 0 &&
			output[output.length - 1]?.trim() !== ""
		) {
			output.push("");
		}

		output.push(line);

		if (
			nextLine !== undefined &&
			(line.match(/^<\/[A-Za-z][\w:-]*>\s*$/) || isStandaloneEmptyBlock) &&
			nextLine.trim() !== ""
		) {
			output.push("");
		}
	}

	return output.join("\n");
}

function blockToPM(node: Content): JSONContent[] {
	switch (node.type) {
		case "paragraph": {
			const paragraphHtml = node.children.every(
				(child) => child.type === "html",
			)
				? node.children.map((child) => child.value).join("")
				: null;
			if (paragraphHtml) {
				const notionBlock = htmlToNotionBlock(paragraphHtml);
				if (notionBlock) return [notionBlock];
				const embed = htmlToEmbed(paragraphHtml);
				if (embed) return [embed];
			}

			return paragraphToPM(node);
		}
		case "heading":
			return [
				{
					type: "heading",
					attrs: { level: node.depth ?? 1 },
					content: inlineToPM(node.children ?? []),
				},
			];
		case "blockquote":
			return [
				{
					type: "blockquote",
					content: (node.children ?? []).flatMap((n) =>
						blockToPM(n as Content),
					),
				},
			];
		case "code":
			if (node.lang === "mermaid") {
				return [{ type: "mermaidBlock", attrs: { raw: node.value ?? "" } }];
			}
			return [
				{
					type: "codeBlock",
					attrs: { language: node.lang ?? null },
					content: node.value ? [{ type: "text", text: node.value }] : [],
				},
			];
		case "thematicBreak":
			return [{ type: "horizontalRule" }];
		case "list": {
			const list = node as List;
			if (list.ordered) {
				// Ordered list: ignore any task checkbox semantics
				return [
					{
						type: "orderedList",
						attrs: { start: list.start ?? 1 },
						content: list.children.flatMap((li) =>
							listItemToPM(li as ListItem, /* allowChecked */ false),
						),
					},
				];
			}

			// Bullet list: allow listItem.checked to flow into attrs.checked
			return [
				{
					type: "bulletList",
					content: list.children.flatMap((li) =>
						listItemToPM(li as ListItem, /* allowChecked */ true),
					),
				},
			];
		}
		case "html": {
			// Parse HTML to extract known block nodes, fallback to text for everything else
			const raw = node.value ?? "";
			if (raw.trim() === "") return [];

			try {
				const hastTree = fromHtml(raw, { fragment: true });
				const notionBlock = hastToNotionBlock(hastTree, raw);
				if (notionBlock) {
					return [notionBlock];
				}
				const notionTable = notionHtmlTableToPM(raw);
				if (notionTable) {
					return notionTable;
				}
				const embed = hastToEmbed(hastTree);
				if (embed) {
					return [embed];
				}
				const images = extractImagesFromHast(hastTree);
				if (images.length > 0) {
					return images;
				}
			} catch {
				// If parsing fails, fall through to text fallback
			}

			// Fallback: keep raw HTML as a text paragraph to avoid data loss
			return [
				{
					type: "paragraph",
					content: [{ type: "text", text: raw }],
				},
			];
		}
		case "table":
			return tableToPM(node as Table);
		case "tableRow":
		case "tableCell":
			return [];
		case "image": {
			return imageToPM(node as Image);
		}
		default: {
			// Unknown block: try to stringify inline if possible or drop.
			// For safety, don’t throw; produce nothing.
			return [];
		}
	}
}

function paragraphToPM(node: Paragraph): JSONContent[] {
	const blocks: JSONContent[] = [];
	const inlineBuffer: Paragraph["children"] = [];
	let trimLeadingText = false;

	function flushParagraph() {
		if (inlineBuffer.length === 0) return;
		blocks.push({
			type: "paragraph",
			content: inlineToPM(inlineBuffer),
		});
		inlineBuffer.length = 0;
	}

	for (const child of node.children ?? []) {
		if (child.type === "image") {
			trimTrailingText(inlineBuffer);
			flushParagraph();
			blocks.push(...imageToPM(child));
			trimLeadingText = true;
			continue;
		}
		if (trimLeadingText && child.type === "text") {
			const value = child.value.replace(/^\s+/, "");
			trimLeadingText = false;
			if (!value) continue;
			inlineBuffer.push({ ...child, value });
			continue;
		}
		trimLeadingText = false;
		inlineBuffer.push(child);
	}
	flushParagraph();

	return blocks.length > 0
		? blocks
		: [
				{
					type: "paragraph",
					content: [],
				},
			];
}

function trimTrailingText(children: Paragraph["children"]) {
	for (let index = children.length - 1; index >= 0; index -= 1) {
		const child = children[index];
		if (!child || child.type !== "text") return;
		const value = child.value.replace(/\s+$/, "");
		if (value) {
			children[index] = { ...child, value };
			return;
		}
		children.pop();
	}
}

function tableToPM(table: Table): JSONContent[] {
	const rows = table.children
		.map((row, rowIndex) => tableRowToPM(row, rowIndex, table.align ?? []))
		.filter((row): row is JSONContent => row.content?.length !== 0);

	if (rows.length === 0) return [];
	return [
		{
			type: "table",
			content: rows,
		},
	];
}

function tableRowToPM(
	row: TableRow,
	rowIndex: number,
	alignments: Table["align"],
): JSONContent {
	const content = row.children.map((cell, columnIndex) =>
		tableCellToPM(cell, rowIndex === 0, alignments?.[columnIndex] ?? null),
	);

	return {
		type: "tableRow",
		content,
	};
}

function tableCellToPM(
	cell: TableCell,
	isHeader: boolean,
	align: AlignType | null | undefined,
): JSONContent {
	return {
		type: isHeader ? "tableHeader" : "tableCell",
		attrs: { align: align ?? null },
		content: [
			{
				type: "paragraph",
				content: inlineToPM(cell.children ?? []),
			},
		],
	};
}

function notionHtmlTableToPM(raw: string): JSONContent[] | null {
	const markdownTable = notionHtmlTableToMarkdown(raw);
	if (!markdownTable) return null;
	return markdownToTiptapDoc(markdownTable).content ?? [];
}

function hastToEmbed(root: HastRoot): JSONContent | null {
	const children = root.children.filter(hasMeaningfulHtml);
	if (children.length !== 1) return null;
	const [node] = children;
	if (!isHastElement(node)) return null;

	const tagName = node.tagName.toLowerCase();
	if (node.children.some(hasMeaningfulHtml)) return null;

	if (tagName === "iframe") {
		const src = getStringProperty(node.properties?.src);
		if (!isValidIframeEmbedSrc(src)) return null;
		return {
			type: "embed",
			attrs: {
				kind: "iframe",
				src,
			},
		};
	}

	return null;
}

function htmlToNotionBlock(raw: string | undefined): JSONContent | null {
	if (!raw?.trim()) return null;
	try {
		return hastToNotionBlock(fromHtml(raw, { fragment: true }), raw);
	} catch {
		return null;
	}
}

function hastToNotionBlock(root: HastRoot, raw: string): JSONContent | null {
	const children = root.children.filter(hasMeaningfulHtml);
	if (children.length !== 1) return null;
	const [node] = children;
	if (!isHastElement(node)) return null;

	const tagName = node.tagName.toLowerCase();
	if (tagName === "empty-block") {
		return { type: "notionEmptyBlock" };
	}

	if (isRawNotionHtmlBlock(tagName)) {
		return {
			type: "notionHtmlBlock",
			attrs: { raw: raw.trim() },
		};
	}

	if (tagName !== "callout") return null;

	const icon = getStringProperty(node.properties?.icon);
	const calloutContent = markdownToTiptapDoc(
		extractCalloutMarkdown(raw),
	).content;
	return {
		type: "notionCallout",
		attrs: {
			icon: icon || null,
			rawAttributes: extractOpeningTagAttributes(raw, "callout"),
		},
		content:
			calloutContent && calloutContent.length > 0
				? calloutContent
				: [{ type: "paragraph" }],
	};
}

function isRawNotionHtmlBlock(tagName: string): boolean {
	return (
		tagName === "bookmark" || tagName === "link-preview" || tagName === "video"
	);
}

function extractOpeningTagAttributes(raw: string, tagName: string): string {
	const match = raw.trim().match(new RegExp(`^<${tagName}\\b([^>]*)>`, "i"));
	return match?.[1]?.trim() ?? "";
}

function extractCalloutMarkdown(raw: string): string {
	const match = raw
		.trim()
		.match(/^<callout\b[^>]*>\n?([\s\S]*?)\n?<\/callout>\s*$/i);
	return dedentNotionBlockMarkdown(match?.[1] ?? "");
}

function dedentNotionBlockMarkdown(markdown: string): string {
	const lines = markdown.split("\n");
	const nonEmptyIndents = lines.flatMap((line) => {
		if (line.trim().length === 0) return [];
		return [line.match(/^[\t ]*/)?.[0] ?? ""];
	});
	const commonIndent = nonEmptyIndents.reduce(
		(common, indent) => {
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
		},
		null as string | null,
	);
	if (!commonIndent) return markdown;
	return lines
		.map((line) =>
			line.startsWith(commonIndent) ? line.slice(commonIndent.length) : line,
		)
		.join("\n");
}

const BLOCKED_IFRAME_SCHEME = /^(file:|data:|javascript:|hubble-asset:)/i;
const LOCAL_IFRAME_SRC = /^(\.{1,2}\/|[^:/\\]+(?:\/|$)).*\.html(?:[?#].*)?$/i;

function getStringProperty(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number") return String(value);
	return "";
}

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

function isHastElement(node: RootContent): node is HastElement {
	return node.type === "element";
}

function hasMeaningfulHtml(node: RootContent): boolean {
	return node.type !== "text" || node.value.trim() !== "";
}

function listItemToPM(li: ListItem, allowChecked: boolean): JSONContent[] {
	// mdast listItem children may be paragraphs and nested lists.
	const blocks = (li.children ?? []) as Content[];
	const first = blocks[0];
	const paragraphContent =
		first && first.type === "paragraph" ? inlineToPM(first.children ?? []) : [];
	const restBlocks = (
		first && first.type === "paragraph" ? blocks.slice(1) : blocks
	).flatMap(blockToPM);
	const content: JSONContent[] = [];
	content.push({ type: "paragraph", content: paragraphContent });
	content.push(...restBlocks);

	const checkedAttr = allowChecked && li.checked != null ? !!li.checked : null;
	return [
		{
			type: "listItem",
			attrs: { checked: checkedAttr },
			content,
		},
	];
}

function imageToPM(imageNode: Image): JSONContent[] {
	if (!imageNode.url) return [];
	return [
		{
			type: "image",
			attrs: {
				src: imageNode.url || "",
				alt: imageNode.alt || "",
				title: imageNode.title || undefined,
			},
		},
	];
}

function htmlToEmbed(raw: string | undefined): JSONContent | null {
	if (!raw?.trim()) return null;
	try {
		return hastToEmbed(fromHtml(raw, { fragment: true }));
	} catch {
		return null;
	}
}

function inlineToPM(children: Content[]): JSONContent[] {
	const out: JSONContent[] = [];
	for (const child of children ?? []) {
		switch (child.type) {
			case "text":
				if (child.value && child.value.length > 0) {
					out.push(...textToPM(child.value));
				}
				break;
			case "strong":
				out.push(...applyMark(inlineToPM(child.children ?? []), "bold"));
				break;
			case "emphasis":
				out.push(...applyMark(inlineToPM(child.children ?? []), "italic"));
				break;
			case "delete":
				out.push(...applyMark(inlineToPM(child.children ?? []), "strike"));
				break;
			case "inlineCode":
				if (child.value) {
					out.push({
						type: "text",
						text: child.value,
						marks: [{ type: "code" }],
					});
				}
				break;
			case "break":
				out.push({ type: "hardBreak" });
				break;
			case "link":
				out.push(
					...applyMark(
						inlineToPM(child.children ?? []),
						"link",
						typeof child.url === "string"
							? { href: child.url, kind: "url", target: null }
							: undefined,
					),
				);
				break;
			case "image":
				// Not supported; render alt text inline.
				if (child.alt) out.push({ type: "text", text: child.alt });
				break;
			case "html":
				if (child.value) {
					out.push(
						...(brHtmlToPM(child.value) ??
							notionMentionToPM(child.value) ?? [
								{ type: "text", text: child.value },
							]),
					);
				}
				break;
			default:
				// Unknown inline; ignore.
				break;
		}
	}
	return out;
}

const BR_TAG_PATTERN = /^<br\s*\/?>$/i;

function brHtmlToPM(raw: string): JSONContent[] | null {
	return BR_TAG_PATTERN.test(raw.trim()) ? [{ type: "hardBreak" }] : null;
}

function notionMentionToPM(raw: string): JSONContent[] | null {
	try {
		const root = fromHtml(raw, { fragment: true });
		const children = root.children.filter(hasMeaningfulHtml);
		if (children.length !== 1) return null;
		const [node] = children;
		if (!isHastElement(node)) return null;
		if (node.tagName.toLowerCase() !== "mention-page") return null;
		if (node.children.some(hasMeaningfulHtml)) return null;

		const href = getStringProperty(node.properties?.url).trim();
		if (!href) return null;
		return [
			{
				type: "text",
				text: notionMentionDisplayText(href),
				marks: [
					{
						type: "link",
						attrs: { href, kind: "notionMention", target: null },
					},
				],
			},
		];
	} catch {
		return null;
	}
}

function notionMentionDisplayText(href: string): string {
	const id = notionPageIdFromUrl(href);
	return id ? `Notion page ${id.slice(0, 8)}` : "Notion page";
}

function notionPageIdFromUrl(href: string): string | null {
	try {
		const url = new URL(href);
		const segments = url.pathname.split("/").filter(Boolean);
		for (let index = segments.length - 1; index >= 0; index -= 1) {
			const id = normalizedNotionPageId(segments[index] ?? "");
			if (id) return id;
		}
	} catch {
		return normalizedNotionPageId(href);
	}
	return null;
}

function normalizedNotionPageId(value: string): string | null {
	const decoded = decodeURIComponent(value);
	const match = decoded.replace(/-/g, "").match(/([0-9a-f]{32})(?:[?#].*)?$/i);
	return match?.[1]?.toLowerCase() ?? null;
}

function textToPM(text: string): JSONContent[] {
	const out: JSONContent[] = [];
	const wikiLinkPattern = /\[\[([^\]\n]+)\]\]/g;
	let lastIndex = 0;
	for (const match of text.matchAll(wikiLinkPattern)) {
		const index = match.index ?? 0;
		if (index > lastIndex) {
			out.push({ type: "text", text: text.slice(lastIndex, index) });
		}

		const rawLink = match[1] ?? "";
		const separatorIndex = rawLink.indexOf("|");
		const rawTarget =
			separatorIndex === -1 ? rawLink : rawLink.slice(0, separatorIndex);
		const rawAlias =
			separatorIndex === -1 ? "" : rawLink.slice(separatorIndex + 1);
		const target = rawTarget.trim();
		if (target) {
			out.push({
				type: "text",
				text: rawAlias || wikiDisplayNameForTarget(target),
				marks: [
					{
						type: "link",
						attrs: { href: target, kind: "wiki", target },
					},
				],
			});
		} else {
			out.push({ type: "text", text: match[0] });
		}
		lastIndex = index + match[0].length;
	}

	if (lastIndex < text.length) {
		out.push({ type: "text", text: text.slice(lastIndex) });
	}
	return out;
}

function applyMark(
	nodes: JSONContent[],
	markType: "bold" | "italic" | "strike" | "link",
	attrs?: Record<string, unknown>,
): JSONContent[] {
	return nodes.map((n) => {
		if (n.type === "text") {
			const existing = n.marks ?? [];
			// Skip stacking a mark type the node already carries. Nested/repeated
			// emphasis (e.g. `****x****`) would otherwise pile up duplicate marks,
			// which the serializer re-emits as `****x****`/`******x******`.
			if (existing.some((mark) => mark.type === markType)) {
				return n;
			}
			const marks = [
				...existing,
				attrs ? { type: markType, attrs } : { type: markType },
			];
			return { ...n, marks };
		}
		// For nested structures, descend if needed; most inline nodes here are text/hardBreak only.
		return n;
	});
}

const EMPTY_PARKER = "HUBBLE_INTERNAL_EMPTY_MARKER";

function rawMarkdownAddEmptyMarkers(rawMarkdown: string) {
	return (
		rawMarkdown
			// Handle empty paragraphs by double newlines
			.split("\n\n")
			.map((line) => {
				// Runs of empty lines are truncated into a single paragraph.
				// Add a marker to force each empty line to be a new paragraph.
				if (line.length === 0) {
					return EMPTY_PARKER;
				}
				return line;
			})
			.join("\n\n")
			// Handle empty checklist items by single newline
			.split("\n")
			.map((line) => {
				if (line.match(/^-\s\[(\s|x)\]\s*$/)) {
					return `${line} ${EMPTY_PARKER}`;
				}
				return line;
			})
			.join("\n")
	);
}

/**
 * Extract image nodes from a HAST tree (parsed HTML).
 */
function extractImagesFromHast(hastTree: HastRoot): JSONContent[] {
	const images: JSONContent[] = [];

	function visitHastNode(node: HastRoot | HastElement) {
		if (node.type === "element" && node.tagName === "img") {
			const attrs: {
				src?: string;
				alt?: string;
				title?: string;
				width?: number;
				height?: number;
			} = {};
			if (node.properties?.src) attrs.src = String(node.properties.src);
			if (node.properties?.alt) attrs.alt = String(node.properties.alt);
			if (node.properties?.title) attrs.title = String(node.properties.title);
			if (node.properties?.width)
				attrs.width = Number(node.properties.width) || undefined;
			if (node.properties?.height)
				attrs.height = Number(node.properties.height) || undefined;

			images.push({ type: "image", attrs });
		}

		if ("children" in node && node.children) {
			for (const child of node.children) {
				if (child.type === "element") {
					visitHastNode(child);
				}
			}
		}
	}

	visitHastNode(hastTree);
	return images;
}

const remarkRemoveEmptyMarkers: Plugin<[]> = () => {
	return (tree) => {
		visit(tree, "paragraph", (node: Paragraph) => {
			const paragraphText = node.children
				.filter((child) => child.type === "text")
				.map((child) => child.value)
				.join("");

			if (paragraphText.includes(EMPTY_PARKER)) {
				node.children = [];
			}
		});
	};
};
