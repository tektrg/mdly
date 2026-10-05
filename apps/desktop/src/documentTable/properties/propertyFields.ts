/**
 * Front-matter properties as typed table-core fields (design note phase 2:
 * "columns from real fields").
 *
 * The schema is INFERRED from the values on disk on every scan; nothing is
 * stored. The durable schema (`.hubble/schema.json`, labels, quarantine —
 * decisions A/F/H) is phase 4 and deliberately absent: a field's type here is
 * only ever a reading of what the files say right now.
 */
import type { FieldDefinition, FieldType, RowValue } from "@tektrg/table-core";
import type {
	ScannedFileStats,
	ScannedFrontMatterProperty,
} from "../../desktopApi/types";
import type { DocumentTableRow } from "../documentTableView";
import {
	type BuiltinFieldId,
	builtinFieldLabel,
	builtinFields,
	addBuiltinRowValues,
	formatBuiltinValue,
	isBuiltinFieldId,
} from "./builtinFields";

export const PROPERTY_FIELD_PREFIX = "prop:";

/**
 * A property column/field id: a front-matter key (`prop:`, lowercased, so
 * `Status` and `status` are one field) or a built-in file property (`file:`,
 * see `builtinFields.ts`). The prefixes keep the two from ever colliding.
 */
export type PropertyFieldId = `prop:${string}` | BuiltinFieldId;

export type PropertyField = FieldDefinition & {
	id: PropertyFieldId;
	/** Documents carrying a non-empty value — the `has <field>` chip count. */
	documentCount: number;
	/** Built-ins: the value comes from the file system and is never written. */
	readOnly?: boolean;
};

export type PropertiesByPath = Readonly<
	Record<string, Readonly<Record<string, ScannedFrontMatterProperty>>>
>;

/** Typed cell values of one document, keyed by property field id. */
export type PropertyRowValues = Readonly<
	Partial<Record<PropertyFieldId, RowValue>>
>;

/** Text values with at most this many distinct options can be a select. */
export const SELECT_MAX_OPTIONS = 20;
/** Longer text reads as prose, never as an option. */
const SELECT_MAX_OPTION_LENGTH = 40;
/** Options kept per field for filter menus, most frequent first. */
const MAX_LISTED_OPTIONS = 50;

export function propertyFieldId(key: string): `prop:${string}` {
	return `${PROPERTY_FIELD_PREFIX}${key.trim().toLowerCase()}`;
}

/** A front-matter id or a known built-in id (unknown `file:` ids are rejected). */
export function isPropertyFieldId(value: unknown): value is PropertyFieldId {
	return (
		isBuiltinFieldId(value) ||
		(typeof value === "string" &&
			value.startsWith(PROPERTY_FIELD_PREFIX) &&
			value.length > PROPERTY_FIELD_PREFIX.length)
	);
}

/** Display label for an id whose field is not (or no longer) in the workspace. */
export function fallbackPropertyLabel(fieldId: PropertyFieldId): string {
	if (isBuiltinFieldId(fieldId)) return builtinFieldLabel(fieldId);
	return fieldId.slice(PROPERTY_FIELD_PREFIX.length);
}

function isEmptyScanned(property: ScannedFrontMatterProperty): boolean {
	if (property.type === "text") return property.value.trim().length === 0;
	if (property.type === "tags") {
		return property.value.every((tag) => tag.trim().length === 0);
	}
	return false;
}

type FieldTally = {
	labelCounts: Map<string, number>;
	typeCounts: Map<ScannedFrontMatterProperty["type"], number>;
	valueCounts: Map<string, number>;
	longestText: number;
	documentCount: number;
};

function inferType(tally: FieldTally): FieldType {
	const types = [...tally.typeCounts.keys()];
	if (types.length === 0) return "text";
	// `tags: work` (a scalar) next to `tags: [a, b]` is still a tag field.
	if (types.every((type) => type === "tags" || type === "text")) {
		if (types.includes("tags")) return "multiSelect";
	}
	if (types.length === 1) {
		const [only] = types;
		if (only === "checkbox") return "boolean";
		if (only === "number") return "number";
		if (only === "date") return "date";
	}
	if (types.length === 1 && types[0] === "text") {
		const distinct = tally.valueCounts.size;
		const repeats = distinct < tally.documentCount;
		if (
			distinct <= SELECT_MAX_OPTIONS &&
			repeats &&
			tally.longestText <= SELECT_MAX_OPTION_LENGTH
		) {
			return "select";
		}
	}
	// Mixed scalars (a number here, text there) read as text: never guess.
	return "text";
}

function scannedOptionValues(property: ScannedFrontMatterProperty): string[] {
	if (property.type === "tags") {
		return property.value.map((tag) => tag.trim()).filter(Boolean);
	}
	return [String(property.value).trim()];
}

function mostCommon(counts: Map<string, number>): string {
	let best = "";
	let bestCount = -1;
	for (const [value, count] of counts) {
		if (count > bestCount) {
			best = value;
			bestCount = count;
		}
	}
	return best;
}

/**
 * One field per distinct (case-insensitive) front-matter key, typed from the
 * values. Ordered by how many documents carry it, then by label, so the
 * commonest properties lead the "add a column" menu.
 */
export function inferPropertyFields(
	propertiesByPath: PropertiesByPath,
): PropertyField[] {
	const tallies = new Map<PropertyFieldId, FieldTally>();
	for (const properties of Object.values(propertiesByPath)) {
		// `Status` and `status` in one file are one field, counted once.
		const seenInDocument = new Set<PropertyFieldId>();
		for (const [key, property] of Object.entries(properties)) {
			if (key.trim().length === 0 || isEmptyScanned(property)) continue;
			const id = propertyFieldId(key);
			if (seenInDocument.has(id)) continue;
			seenInDocument.add(id);
			let tally = tallies.get(id);
			if (!tally) {
				tally = {
					labelCounts: new Map(),
					typeCounts: new Map(),
					valueCounts: new Map(),
					longestText: 0,
					documentCount: 0,
				};
				tallies.set(id, tally);
			}
			tally.documentCount += 1;
			tally.labelCounts.set(key, (tally.labelCounts.get(key) ?? 0) + 1);
			tally.typeCounts.set(
				property.type,
				(tally.typeCounts.get(property.type) ?? 0) + 1,
			);
			for (const option of scannedOptionValues(property)) {
				tally.valueCounts.set(option, (tally.valueCounts.get(option) ?? 0) + 1);
				if (option.length > tally.longestText) {
					tally.longestText = option.length;
				}
			}
		}
	}

	const fields: PropertyField[] = [];
	for (const [id, tally] of tallies) {
		const type = inferType(tally);
		const field: PropertyField = {
			id,
			label: mostCommon(tally.labelCounts),
			type,
			documentCount: tally.documentCount,
		};
		if (type === "select" || type === "multiSelect") {
			field.options = [...tally.valueCounts.entries()]
				.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
				.slice(0, MAX_LISTED_OPTIONS)
				.map(([value]) => value);
		}
		fields.push(field);
	}
	return fields.sort(
		(a, b) =>
			b.documentCount - a.documentCount ||
			a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
	);
}

/** One scanned value as the cell value its field type expects; null = empty. */
export function toPropertyRowValue(
	property: ScannedFrontMatterProperty,
	type: FieldType,
): RowValue {
	if (isEmptyScanned(property)) return null;
	switch (type) {
		case "multiSelect":
			return scannedOptionValues(property);
		case "boolean":
			return property.type === "checkbox" ? property.value : null;
		case "number":
			return property.type === "number" ? property.value : null;
		case "date":
			return property.type === "date" ? property.value : null;
		default:
			return property.type === "tags"
				? property.value.join(", ")
				: String(property.value);
	}
}

/** Typed values per path for the given fields. Paths without properties are absent. */
export function buildPropertyRowValues(
	propertiesByPath: PropertiesByPath,
	fields: readonly PropertyField[],
): Map<string, PropertyRowValues> {
	const typeById = new Map(fields.map((field) => [field.id, field.type]));
	const valuesByPath = new Map<string, PropertyRowValues>();
	for (const [path, properties] of Object.entries(propertiesByPath)) {
		const values: Partial<Record<PropertyFieldId, RowValue>> = {};
		for (const [key, property] of Object.entries(properties)) {
			const id = propertyFieldId(key);
			const type = typeById.get(id);
			if (!type || id in values) continue;
			const value = toPropertyRowValue(property, type);
			if (value !== null) values[id] = value;
		}
		valuesByPath.set(path, values);
	}
	return valuesByPath;
}

/**
 * Cell text. Booleans read as words so a filtered "No" is never a blank cell;
 * built-ins (given `fieldId`) read as sizes, counts and short date-times.
 */
export function formatPropertyValue(
	value: RowValue,
	fieldId?: PropertyFieldId,
): string {
	if (value === null || value === undefined) return "";
	const builtinText = fieldId ? formatBuiltinValue(fieldId, value) : null;
	if (builtinText !== null) return builtinText;
	if (Array.isArray(value)) return value.join(", ");
	if (typeof value === "boolean") return value ? "Yes" : "No";
	return String(value);
}

export type PropertyModel = {
	fields: PropertyField[];
	valuesByPath: ReadonlyMap<string, PropertyRowValues>;
};

export const EMPTY_PROPERTY_MODEL: PropertyModel = {
	fields: [],
	valuesByPath: new Map(),
};

/** The listing rows and whole-file stats the built-in fields read. */
export type BuiltinFieldSource = {
	rows: readonly DocumentTableRow[];
	statsByPath: Readonly<Record<string, ScannedFileStats>>;
};

const EMPTY_BUILTIN_SOURCE: BuiltinFieldSource = { rows: [], statsByPath: {} };

let modelMemo: {
	source: PropertiesByPath;
	builtinSource: BuiltinFieldSource;
	model: PropertyModel;
} | null = null;

/**
 * Inferred fields + typed values, memoized on the scan map's and the
 * listing's identity: one inference per scan batch, never per render or
 * keystroke. Front-matter fields first, then the built-ins; every listed
 * row carries its built-in values.
 */
export function derivePropertyModel(
	propertiesByPath: PropertiesByPath,
	builtinSource: BuiltinFieldSource = EMPTY_BUILTIN_SOURCE,
): PropertyModel {
	if (
		modelMemo?.source === propertiesByPath &&
		modelMemo.builtinSource.rows === builtinSource.rows &&
		modelMemo.builtinSource.statsByPath === builtinSource.statsByPath
	) {
		return modelMemo.model;
	}
	const frontMatterFields = inferPropertyFields(propertiesByPath);
	const frontMatterValues = buildPropertyRowValues(
		propertiesByPath,
		frontMatterFields,
	);
	const { rows, statsByPath } = builtinSource;
	const fields = [
		...frontMatterFields,
		...(rows.length > 0
			? builtinFields(rows, frontMatterFields, Object.keys(statsByPath).length)
			: []),
	];
	const valuesByPath = rows.length > 0 ? new Map<string, PropertyRowValues>() : frontMatterValues;
	for (const row of rows) {
		const values: Partial<Record<PropertyFieldId, RowValue>> = {
			...frontMatterValues.get(row.path),
		};
		addBuiltinRowValues(values, row, statsByPath[row.path]);
		valuesByPath.set(row.path, values);
	}
	const model =
		fields.length === 0 ? EMPTY_PROPERTY_MODEL : { fields, valuesByPath };
	modelMemo = { source: propertiesByPath, builtinSource, model };
	return model;
}
