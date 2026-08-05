import {
	combineMarkdownFrontMatter,
	type FileProperty,
	isSimplePropertyKey,
	parseMarkdownFrontMatter,
	serializeFrontMatter,
} from "@mdly/workspace-kit";

type PropertyValue = string | number | boolean | string[];

export type HtmlAppFileProperties = Record<string, PropertyValue>;

export type HtmlAppFilePropertyPatch = Record<string, PropertyValue | null>;

export type HtmlAppFile = {
	path: string;
	body: string;
	properties: HtmlAppFileProperties;
};

export type HtmlAppFilePatch = {
	body?: string;
	properties?: HtmlAppFilePropertyPatch;
};

export function parseMarkdownFile(path: string, markdown: string): HtmlAppFile {
	const parsed = parseMarkdownFrontMatter(markdown);
	return {
		path,
		body: parsed.type === "none" ? markdown : parsed.body,
		properties:
			parsed.type === "valid" ? propertiesToObject(parsed.properties) : {},
	};
}

export function applyPatchToMarkdown(
	markdown: string,
	patch: HtmlAppFilePatch,
): string {
	const hasBody = hasOwn(patch, "body");
	const hasProperties = hasOwn(patch, "properties");
	if (!hasBody && !hasProperties) {
		throw new Error("Pass body, properties, or both.");
	}

	const parsed = parseMarkdownFrontMatter(markdown);
	const body = hasBody ? String(patch.body ?? "") : getBody(parsed, markdown);
	if (!hasProperties) {
		if (parsed.type === "none") return body;
		return combineMarkdownFrontMatter(parsed.raw, body);
	}

	if (parsed.type === "invalid") {
		throw new Error("Cannot update properties while front matter is invalid.");
	}

	const properties = patchProperties(
		parsed.type === "valid" ? parsed.properties : [],
		patch.properties,
	);
	return combineMarkdownFrontMatter(serializeFrontMatter(properties), body);
}

export function propertiesToObject(
	properties: FileProperty[],
): HtmlAppFileProperties {
	const result: HtmlAppFileProperties = {};
	for (const property of properties) {
		if (property.type === "unsupported") continue;
		result[property.key] = property.value;
	}
	return result;
}

function getBody(
	parsed: ReturnType<typeof parseMarkdownFrontMatter>,
	markdown: string,
) {
	return parsed.type === "none" ? markdown : parsed.body;
}

function patchProperties(
	current: FileProperty[],
	patch: HtmlAppFilePropertyPatch | undefined,
) {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
		throw new Error("properties must be an object.");
	}

	const next = current.filter((property) => {
		return !hasOwn(patch, property.key) || patch[property.key] !== null;
	});
	const indexes = new Map(next.map((property, index) => [property.key, index]));

	for (const [key, value] of Object.entries(patch)) {
		if (!isSimplePropertyKey(key)) {
			throw new Error(`Invalid property key: ${key}`);
		}
		if (value === null) continue;
		const property = propertyFromValue(key, value);
		const index = indexes.get(key);
		if (index === undefined) {
			indexes.set(key, next.length);
			next.push(property);
		} else {
			next[index] = property;
		}
	}

	return next;
}

function hasOwn(object: object, key: string) {
	return Object.keys(object).includes(key);
}

function propertyFromValue(key: string, value: PropertyValue): FileProperty {
	if (typeof value === "string") return { key, type: "text", value };
	if (typeof value === "number" && Number.isFinite(value)) {
		return { key, type: "number", value };
	}
	if (typeof value === "boolean") return { key, type: "checkbox", value };
	if (
		Array.isArray(value) &&
		value.every((item): item is string => typeof item === "string")
	) {
		return { key, type: "tags", value };
	}
	throw new Error(
		`Invalid value for ${key}. Use string, number, boolean, string[], or null.`,
	);
}
