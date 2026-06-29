import {
	isMap,
	isScalar,
	isSeq,
	type Pair,
	parseDocument,
	type Scalar,
	stringify,
	type YAMLMap,
	type YAMLSeq,
} from "yaml";

export type FilePropertyType =
	| "text"
	| "number"
	| "checkbox"
	| "date"
	| "tags"
	| "unsupported";

export type SupportedFileProperty =
	| { key: string; type: "text"; value: string }
	| { key: string; type: "number"; value: number }
	| { key: string; type: "checkbox"; value: boolean }
	| { key: string; type: "date"; value: string }
	| { key: string; type: "tags"; value: string[] };

export type UnsupportedFileProperty = {
	key: string;
	type: "unsupported";
	raw: string;
	preview: string;
};

export type FileProperty = SupportedFileProperty | UnsupportedFileProperty;

export type ParsedFrontMatter =
	| { type: "none"; body: string }
	| { type: "invalid"; raw: string; body: string; error: string }
	| { type: "valid"; raw: string; body: string; properties: FileProperty[] };

export function parseMarkdownFrontMatter(markdown: string): ParsedFrontMatter {
	const split = splitFrontMatter(markdown);
	if (!split) return { type: "none", body: markdown };

	const doc = parseDocument(split.raw, {
		schema: "core",
		keepSourceTokens: true,
		uniqueKeys: true,
	});
	if (doc.errors.length > 0) {
		return {
			type: "invalid",
			raw: split.raw,
			body: split.body,
			error: doc.errors[0]?.message ?? "Invalid front matter",
		};
	}
	if (!isMap(doc.contents)) {
		return {
			type: "invalid",
			raw: split.raw,
			body: split.body,
			error: "Front matter must be a plain object",
		};
	}

	return {
		type: "valid",
		raw: split.raw,
		body: split.body,
		properties: mapToProperties(doc.contents, split.raw),
	};
}

export function serializeFrontMatter(properties: FileProperty[]): string {
	if (properties.length === 0) return "";
	const lines: string[] = [];
	for (const property of properties) {
		if (property.type === "unsupported") {
			lines.push(property.raw.trimEnd());
			continue;
		}
		if (!isSimplePropertyKey(property.key)) continue;
		if (property.type === "text") {
			lines.push(
				`${property.key}: ${stringify(property.value, {
					defaultStringType: "QUOTE_DOUBLE",
				}).trimEnd()}`,
			);
			continue;
		}
		lines.push(stringify({ [property.key]: property.value }).trimEnd());
	}
	return lines.join("\n");
}

export function combineMarkdownFrontMatter(
	frontMatter: string,
	body: string,
): string {
	const trimmed = frontMatter.trim();
	if (trimmed.length === 0) return body;
	return `---\n${trimmed}\n---${body.startsWith("\n") ? "" : "\n"}${body}`;
}

export function setMarkdownFrontMatter(
	markdown: string,
	frontMatter: string,
): string {
	const parsed = parseMarkdownFrontMatter(markdown);
	return combineMarkdownFrontMatter(frontMatter, parsed.body);
}

export function detectFilePropertyType(value: string): FilePropertyType {
	const trimmed = value.trim();
	if (trimmed === "true" || trimmed === "false") return "checkbox";
	if (parseDateInput(trimmed)) return "date";
	if (isNumberString(trimmed)) return "number";
	return "text";
}

export function isDateString(value: string): boolean {
	return parseDateInput(value) === value;
}

// Accept explicit numeric dates only: YYYY-M-D or M-D-YYYY, with either
// dashes or slashes. Valid inputs are normalized to YYYY-MM-DD.
export function parseDateInput(value: string): string | null {
	const trimmed = value.trim();
	const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(trimmed);
	if (iso) return normalizedDate(iso[1], iso[2], iso[3]);
	const us = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(trimmed);
	if (us) return normalizedDate(us[3], us[1], us[2]);
	return null;
}

function normalizedDate(yearText: string, monthText: string, dayText: string) {
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const date = new Date(Date.UTC(year, month - 1, day));
	const valid =
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day;
	if (!valid) return null;
	return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function isSimplePropertyKey(key: string): boolean {
	return /^[a-zA-Z0-9_-]+$/.test(key);
}

function splitFrontMatter(markdown: string) {
	const start = markdown.match(/^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/);
	if (!start) return null;
	const firstBlock = consumeFrontMatterBlock(markdown, 0);
	if (!firstBlock) return null;

	const firstKeys = frontMatterMapKeys(firstBlock.raw);
	let bodyStart = firstBlock.end;
	while (true) {
		const nextStart = leadingWhitespaceEnd(markdown, bodyStart);
		const nextBlock = consumeFrontMatterBlock(markdown, nextStart);
		if (!nextBlock || !hasRepeatedFrontMatterKeys(firstKeys, nextBlock.raw)) {
			break;
		}
		bodyStart = nextBlock.end;
	}

	return { raw: firstBlock.raw, body: markdown.slice(bodyStart) };
}

function consumeFrontMatterBlock(markdown: string, startIndex: number) {
	const start = markdown
		.slice(startIndex)
		.match(/^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/);
	if (!start) return null;
	const startLength = start[0].length;
	const restStart = startIndex + startLength;
	const rest = markdown.slice(restStart);
	const closing = rest.match(/(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/);
	if (!closing || closing.index === undefined) {
		return { raw: rest, end: markdown.length };
	}
	const raw = rest.slice(0, closing.index);
	const closingText = closing[0];
	return {
		raw,
		end: restStart + closing.index + closingText.length,
	};
}

function leadingWhitespaceEnd(markdown: string, startIndex: number): number {
	const whitespace = markdown.slice(startIndex).match(/^(?:[ \t]*\r?\n)*/);
	return startIndex + (whitespace?.[0].length ?? 0);
}

function frontMatterMapKeys(raw: string): Set<string> {
	const doc = parseDocument(raw, { schema: "core", uniqueKeys: true });
	if (doc.errors.length > 0 || !isMap(doc.contents)) return new Set();
	return new Set(
		doc.contents.items.flatMap((item) => {
			const key = scalarValue(item.key);
			return typeof key === "string" ? [key] : [];
		}),
	);
}

function hasRepeatedFrontMatterKeys(
	firstKeys: Set<string>,
	raw: string,
): boolean {
	if (firstKeys.size === 0) return false;
	const nextKeys = frontMatterMapKeys(raw);
	if (nextKeys.size !== firstKeys.size) return false;
	for (const key of firstKeys) {
		if (!nextKeys.has(key)) return false;
	}
	return true;
}

function mapToProperties(map: YAMLMap, raw: string): FileProperty[] {
	return map.items.flatMap((item, index) => {
		const key = scalarValue(item.key);
		if (typeof key !== "string") return [];
		const rawPair = rawPairForItem(raw, item, map.items[index + 1]);
		if (!isSimplePropertyKey(key)) {
			return [unsupportedProperty(key, item.value, rawPair)];
		}
		const value = item.value;
		if (!value || (isScalar(value) && value.value == null)) {
			return [{ key, type: "text", value: "" }];
		}
		if (isScalar(value)) return scalarProperty(key, value, rawPair);
		if (isSeq(value)) return seqProperty(key, value, rawPair);
		return [unsupportedProperty(key, value, rawPair)];
	});
}

function scalarProperty(
	key: string,
	scalar: Scalar,
	rawPair: string,
): FileProperty[] {
	const value = scalar.value;
	if (typeof value === "boolean") return [{ key, type: "checkbox", value }];
	if (typeof value === "number") return [{ key, type: "number", value }];
	if (typeof value !== "string") {
		return [unsupportedProperty(key, scalar, rawPair)];
	}
	if (isDateString(value)) return [{ key, type: "date", value }];
	return [{ key, type: "text", value }];
}

function seqProperty(
	key: string,
	seq: YAMLSeq,
	rawPair: string,
): FileProperty[] {
	const values: string[] = [];
	for (const item of seq.items) {
		if (!isScalar(item) || typeof item.value !== "string") {
			return [unsupportedProperty(key, seq, rawPair)];
		}
		values.push(item.value);
	}
	return [{ key, type: "tags", value: values }];
}

function unsupportedProperty(
	key: string,
	value: unknown,
	raw: string,
): UnsupportedFileProperty {
	return {
		key,
		type: "unsupported",
		raw,
		preview: unsupportedPreview(value),
	};
}

function rawPairForItem(
	raw: string,
	item: Pair<unknown, unknown>,
	nextItem?: Pair<unknown, unknown>,
): string {
	const start = itemStartOffset(item);
	const end = nextItem ? itemStartOffset(nextItem) : raw.length;
	if (start === null || end === null || end <= start) {
		const key = scalarValue(item.key);
		return typeof key === "string" ? pairToRaw(key, item.value) : "";
	}
	return raw.slice(start, end).trimEnd();
}

function itemStartOffset(item: Pair<unknown, unknown>): number | null {
	const token = item.srcToken;
	const startToken = token?.start?.find((part) => part.type !== "space");
	if (startToken) return startToken.offset;
	const keyOffset = token?.key?.offset;
	if (typeof keyOffset === "number") return keyOffset;
	const valueOffset = token?.value?.offset;
	return typeof valueOffset === "number" ? valueOffset : null;
}

function unsupportedPreview(value: unknown): string {
	if (!value || (isScalar(value) && value.value == null)) return "Empty";
	if (isScalar(value)) return String(value.value);
	if (isSeq(value)) {
		const scalarValues = value.items.flatMap((item) => {
			return isScalar(item) && item.value != null ? [String(item.value)] : [];
		});
		if (scalarValues.length === value.items.length) {
			return scalarValues.length === 0 ? "Empty list" : scalarValues.join(", ");
		}
		return `${value.items.length} item${value.items.length === 1 ? "" : "s"}`;
	}
	if (isMap(value)) return "Object";
	return "Unsupported YAML";
}

function scalarValue(node: unknown) {
	return isScalar(node) ? node.value : null;
}

function pairToRaw(key: string, value: unknown): string {
	return stringify({ [key]: valueToJs(value) }).trimEnd();
}

function valueToJs(value: unknown): unknown {
	if (isScalar(value)) return value.value;
	if (isSeq(value)) {
		return value.items.map(valueToJs);
	}
	if (isMap(value)) {
		return Object.fromEntries(
			value.items.map((item) => [
				String(scalarValue(item.key) ?? ""),
				valueToJs(item.value),
			]),
		);
	}
	return value;
}

function isNumberString(value: string): boolean {
	if (value.length === 0) return false;
	if (!/^-?(?:\d+|\d*\.\d+)$/.test(value)) return false;
	return Number.isFinite(Number(value));
}
