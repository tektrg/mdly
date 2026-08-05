import type {
	Element as HastElement,
	Root as HastRoot,
	RootContent,
} from "hast";
import { fromHtml } from "hast-util-from-html";

type NotionHtmlTable = {
	headerRow: boolean;
	rows: NotionHtmlTableRow[];
};

type NotionHtmlTableRow = {
	cells: NotionHtmlTableCell[];
};

type NotionHtmlTableCell = {
	header: boolean;
	text: string;
};

type FenceState = {
	marker: "`" | "~";
	length: number;
};

const FENCE_OPEN_LINE = /^[ \t]{0,3}(`{3,}|~{3,})/;

export function notionHtmlTableToMarkdown(raw: string): string | null {
	const table = parseNotionHtmlTable(raw);
	if (!table) return null;

	const columnCount = Math.max(...table.rows.map((row) => row.cells.length));
	if (columnCount === 0) return null;

	const [firstRow, ...bodyRows] = table.rows;
	if (!firstRow) return null;

	const headerCells = cellsForRow(firstRow, columnCount);
	const rows =
		table.headerRow || firstRow.cells.some((cell) => cell.header)
			? bodyRows
			: table.rows.slice(1);

	return [
		serializeTableRow(headerCells),
		serializeDelimiterRow(columnCount),
		...rows.map((row) => serializeTableRow(cellsForRow(row, columnCount))),
	].join("\n");
}

export function normalizeNotionHtmlTables(markdown: string): string {
	const lines = markdown.split("\n");
	const output: string[] = [];
	let fence: FenceState | null = null;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
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

		if (fence) {
			output.push(line);
			continue;
		}

		if (!startsHtmlTable(line)) {
			output.push(line);
			continue;
		}

		const tableLines = [line];
		while (
			!endsHtmlTable(tableLines[tableLines.length - 1] ?? "") &&
			index + 1 < lines.length
		) {
			index += 1;
			tableLines.push(lines[index] ?? "");
		}

		const rawTable = tableLines.join("\n");
		const markdownTable = notionHtmlTableToMarkdown(rawTable);
		output.push(markdownTable ?? rawTable);
	}

	return output.join("\n");
}

function closesFence(line: string, fence: FenceState): boolean {
	const escapedMarker = fence.marker === "`" ? "`" : "~";
	const pattern = new RegExp(
		`^[ \\t]{0,3}${escapedMarker}{${fence.length},}[ \\t]*$`,
	);
	return pattern.test(line);
}

function parseNotionHtmlTable(raw: string): NotionHtmlTable | null {
	let root: HastRoot;
	try {
		root = fromHtml(raw, { fragment: true });
	} catch {
		return null;
	}

	const children = root.children.filter(hasMeaningfulHtml);
	if (children.length !== 1) return null;
	const [node] = children;
	if (!isHastElement(node) || node.tagName.toLowerCase() !== "table") {
		return null;
	}

	if (hasUnsupportedTableAttributes(node)) return null;

	const rowElements = directTableRows(node);
	const rows: NotionHtmlTableRow[] = [];
	for (const rowElement of rowElements) {
		const row = tableRowFromElement(rowElement);
		if (!row) return null;
		rows.push(row);
	}
	if (rows.length === 0) return null;

	const headerRow = booleanHtmlAttribute(node.properties?.headerRow);
	return { headerRow, rows };
}

function directTableRows(table: HastElement): HastElement[] {
	const rows: HastElement[] = [];
	for (const child of table.children) {
		if (!isHastElement(child)) continue;
		const tagName = child.tagName.toLowerCase();
		if (tagName === "tr") {
			rows.push(child);
		} else if (tagName === "thead" || tagName === "tbody") {
			rows.push(...child.children.filter(isTableRowElement));
		} else if (tagName === "colgroup" || tagName === "caption") {
			// Column-width/caption metadata carries no row content — skip it
			// rather than aborting the whole table (Notion exports always
			// include a <colgroup>).
		} else if (hasMeaningfulHtml(child)) {
			return [];
		}
	}
	return rows;
}

function tableRowFromElement(row: HastElement): NotionHtmlTableRow | null {
	if (hasUnsupportedTableAttributes(row)) return null;

	const cells: NotionHtmlTableCell[] = [];
	for (const child of row.children) {
		if (!isHastElement(child)) {
			if (hasMeaningfulHtml(child)) return null;
			continue;
		}

		const tagName = child.tagName.toLowerCase();
		if (tagName !== "td" && tagName !== "th") {
			if (hasMeaningfulHtml(child)) return null;
			continue;
		}
		if (hasUnsupportedTableAttributes(child)) return null;

		const text = cellText(child);
		if (text === null) return null;
		cells.push({ header: tagName === "th", text });
	}

	return cells.length > 0 ? { cells } : null;
}

function cellText(cell: HastElement): string | null {
	const chunks: string[] = [];

	for (const child of cell.children) {
		const text = plainTextFromHtml(child);
		if (text === null) return null;
		chunks.push(text);
	}

	return chunks.join("").replace(/\s+/g, " ").trim();
}

function plainTextFromHtml(node: RootContent): string | null {
	if (node.type === "text") return node.value;
	if (!isHastElement(node)) return hasMeaningfulHtml(node) ? null : "";

	const tagName = node.tagName.toLowerCase();
	if (tagName === "br") return "<br>";
	if (tagName === "p" || tagName === "div") {
		const chunks: string[] = [];
		for (const child of node.children) {
			const text = plainTextFromHtml(child);
			if (text === null) return null;
			chunks.push(text);
		}
		return chunks.join("");
	}

	return null;
}

function hasUnsupportedTableAttributes(element: HastElement): boolean {
	return Boolean(element.properties?.rowSpan || element.properties?.colSpan);
}

function cellsForRow(row: NotionHtmlTableRow, columnCount: number): string[] {
	return Array.from({ length: columnCount }, (_, index) =>
		escapeTableCell(row.cells[index]?.text ?? ""),
	);
}

function serializeTableRow(cells: string[]): string {
	return `| ${cells.join(" | ")} |`;
}

function serializeDelimiterRow(columnCount: number): string {
	return `| ${Array.from({ length: columnCount }, () => "---").join(" | ")} |`;
}

function escapeTableCell(text: string): string {
	return text.split("|").join("\\|").replace(/\r?\n/g, "<br>");
}

function startsHtmlTable(line: string): boolean {
	return /^\s*<table\b/i.test(line);
}

function endsHtmlTable(line: string): boolean {
	return /<\/table>\s*$/i.test(line);
}

function isTableRowElement(node: RootContent): node is HastElement {
	return isHastElement(node) && node.tagName.toLowerCase() === "tr";
}

function isHastElement(node: RootContent): node is HastElement {
	return node.type === "element";
}

function hasMeaningfulHtml(node: RootContent): boolean {
	return node.type !== "text" || node.value.trim() !== "";
}

function booleanHtmlAttribute(value: unknown): boolean {
	if (value === true) return true;
	if (typeof value === "string") return value.toLowerCase() === "true";
	if (Array.isArray(value)) {
		return value.some((item) => booleanHtmlAttribute(item));
	}
	return false;
}
