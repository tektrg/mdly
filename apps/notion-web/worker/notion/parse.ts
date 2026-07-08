// Parsing of Notion REST responses into the shapes the SPA consumes.
// Ported from apps/desktop/electron/notion.ts (the CLI returned the same
// underlying Notion object JSON, so the parsing is identical).

export type NotionObjectType = "page" | "database" | "data_source";

export type NotionSearchResult = {
	id: string;
	object: NotionObjectType;
	title: string;
	url: string | null;
	lastEditedTime: string | null;
};

export type NotionDatabaseRow = {
	pageId: string;
	title: string;
	url: string | null;
	lastEditedTime: string | null;
	properties: Record<string, string>;
};

function readObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

export function parseSearchResults(parsed: unknown): NotionSearchResult[] {
	const results = readObject(parsed).results;
	if (!Array.isArray(results)) return [];

	return results.flatMap((result): NotionSearchResult[] => {
		const object = readObject(result);
		const notionObject = object.object;
		if (!isNotionObjectType(notionObject)) return [];
		const id = typeof object.id === "string" ? object.id : null;
		if (!id) return [];
		return [
			{
				id,
				object: notionObject,
				title: titleForSearchResult(object, notionObject),
				url: typeof object.url === "string" ? object.url : null,
				lastEditedTime:
					typeof object.last_edited_time === "string"
						? object.last_edited_time
						: null,
			},
		];
	});
}

export function parseDatabaseRows(parsed: unknown): {
	columns: string[];
	rows: NotionDatabaseRow[];
	hasMore: boolean;
	nextCursor: string | null;
} {
	const object = readObject(parsed);
	const results = Array.isArray(object.results) ? object.results : [];
	const rows = results.flatMap((row): NotionDatabaseRow[] => {
		const rowObject = readObject(row);
		const pageId = typeof rowObject.id === "string" ? rowObject.id : null;
		if (!pageId) return [];
		return [
			{
				pageId,
				title: titleForSearchResult(rowObject, "page"),
				url: typeof rowObject.url === "string" ? rowObject.url : null,
				lastEditedTime:
					typeof rowObject.last_edited_time === "string"
						? rowObject.last_edited_time
						: null,
				properties: formatProperties(readObject(rowObject.properties)),
			},
		];
	});
	return {
		columns: databaseColumns(rows),
		rows,
		hasMore: object.has_more === true,
		nextCursor:
			typeof object.next_cursor === "string" ? object.next_cursor : null,
	};
}

function isNotionObjectType(value: unknown): value is NotionObjectType {
	return value === "page" || value === "database" || value === "data_source";
}

function titleForSearchResult(
	result: Record<string, unknown>,
	object: NotionObjectType,
): string {
	if (object === "page") {
		const properties = readObject(result.properties);
		for (const property of Object.values(properties)) {
			const propertyObject = readObject(property);
			if (propertyObject.type !== "title") continue;
			const title = richTextPlainText(propertyObject.title);
			if (title) return title;
		}
	}

	const title = richTextPlainText(result.title);
	if (title) return title;
	return object === "page"
		? "Untitled Notion page"
		: "Untitled Notion database";
}

function richTextPlainText(value: unknown): string | null {
	if (!Array.isArray(value)) return null;
	const text = value
		.map((part) => {
			const object = readObject(part);
			return typeof object.plain_text === "string" ? object.plain_text : "";
		})
		.join("")
		.trim();
	return text || null;
}

function formatProperties(
	properties: Record<string, unknown>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(properties).map(([name, property]) => [
			name,
			formatPropertyValue(readObject(property)),
		]),
	);
}

function formatPropertyValue(property: Record<string, unknown>): string {
	const type = typeof property.type === "string" ? property.type : "";
	switch (type) {
		case "title":
		case "rich_text":
			return richTextPlainText(property[type]) ?? "";
		case "number":
			return property.number === null || property.number === undefined
				? ""
				: String(property.number);
		case "select":
		case "status":
			return optionName(property[type]);
		case "multi_select":
			return Array.isArray(property.multi_select)
				? property.multi_select.map(optionName).filter(Boolean).join(", ")
				: "";
		case "date":
			return formatDateProperty(property.date);
		case "checkbox":
			return property.checkbox === true ? "Yes" : "No";
		case "url":
		case "email":
		case "phone_number":
			return typeof property[type] === "string"
				? (property[type] as string)
				: "";
		case "people":
			return Array.isArray(property.people)
				? property.people.map(personName).filter(Boolean).join(", ")
				: "";
		case "files":
			return Array.isArray(property.files)
				? property.files.map(fileName).filter(Boolean).join(", ")
				: "";
		case "relation":
			return Array.isArray(property.relation)
				? `${property.relation.length} relation${property.relation.length === 1 ? "" : "s"}`
				: "";
		case "formula":
			return formatPropertyValue(readObject(property.formula));
		case "rollup":
			return formatRollupProperty(readObject(property.rollup));
		case "created_time":
		case "last_edited_time":
			return typeof property[type] === "string"
				? (property[type] as string)
				: "";
		case "created_by":
		case "last_edited_by":
			return personName(property[type]);
		case "unique_id":
			return formatUniqueId(readObject(property.unique_id));
		default:
			return "";
	}
}

function optionName(value: unknown): string {
	const object = readObject(value);
	return typeof object.name === "string" ? object.name : "";
}

function personName(value: unknown): string {
	const object = readObject(value);
	return typeof object.name === "string" ? object.name : "";
}

function fileName(value: unknown): string {
	const object = readObject(value);
	return typeof object.name === "string" ? object.name : "";
}

function formatDateProperty(value: unknown): string {
	const object = readObject(value);
	const start = typeof object.start === "string" ? object.start : "";
	const end = typeof object.end === "string" ? object.end : "";
	if (start && end) return `${start} → ${end}`;
	return start;
}

function formatRollupProperty(rollup: Record<string, unknown>): string {
	const type = typeof rollup.type === "string" ? rollup.type : "";
	if (type === "number") {
		return rollup.number === null || rollup.number === undefined
			? ""
			: String(rollup.number);
	}
	if (type === "date") return formatDateProperty(rollup.date);
	if (type === "array" && Array.isArray(rollup.array)) {
		return rollup.array
			.map((entry) => formatPropertyValue(readObject(entry)))
			.filter(Boolean)
			.join(", ");
	}
	return "";
}

function formatUniqueId(value: Record<string, unknown>): string {
	const prefix = typeof value.prefix === "string" ? value.prefix : "";
	const number =
		value.number === null || value.number === undefined
			? ""
			: String(value.number);
	if (!number) return "";
	return prefix ? `${prefix}-${number}` : number;
}

function databaseColumns(rows: NotionDatabaseRow[]): string[] {
	const columns: string[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		for (const name of Object.keys(row.properties)) {
			if (seen.has(name)) continue;
			seen.add(name);
			columns.push(name);
		}
	}
	return columns;
}
