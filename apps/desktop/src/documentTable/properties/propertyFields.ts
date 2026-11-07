/**
 * Front-matter properties as typed table-core fields (design note phase 2:
 * "columns from real fields").
 *
 * The schema is INFERRED from the values on disk on every scan; nothing is
 * stored. The durable schema (`.hubble/schema.json`, labels, quarantine —
 * decisions A/F/H) is phase 4 and deliberately absent: a field's type here is
 * only ever a reading of what the files say right now.
 */
import {
	type FieldDefinition,
	type FieldType,
	isViewFieldId,
	PROPERTY_FIELD_PREFIX,
	propertyFieldId,
	type RowValue,
	type ViewFieldId,
} from "@tektrg/table-core";
import type {
	ScannedFileStats,
	ScannedFrontMatterProperty,
} from "../../desktopApi/types";
import type { DocumentTableRow } from "../documentTableView";
import {
	builtinFieldLabel,
	builtinFields,
	formatBuiltinValue,
	isBuiltinFieldId,
} from "./builtinFields";

export { PROPERTY_FIELD_PREFIX, propertyFieldId };

/**
 * A property column/field id: a front-matter key (`prop:`, lowercased, so
 * `Status` and `status` are one field) or a built-in file property (`file:`,
 * see `builtinFields.ts`). The prefixes keep the two from ever colliding.
 */
export type PropertyFieldId = ViewFieldId;

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

/** A front-matter id or a known built-in id (unknown `file:` ids are rejected). */
export const isPropertyFieldId = isViewFieldId;

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
	documentCount: number;
};

/** Field tallies keyed by id. Counts go up and down, so a scan batch updates them in place. */
export type PropertyTallies = Map<PropertyFieldId, FieldTally>;

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
			longestOption(tally) <= SELECT_MAX_OPTION_LENGTH
		) {
			return "select";
		}
	}
	// Mixed scalars (a number here, text there) read as text: never guess.
	return "text";
}

function longestOption(tally: FieldTally): number {
	let longest = 0;
	for (const option of tally.valueCounts.keys()) {
		if (option.length > longest) longest = option.length;
	}
	return longest;
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

function bump<K>(counts: Map<K, number>, key: K, by: number) {
	const next = (counts.get(key) ?? 0) + by;
	if (next > 0) counts.set(key, next);
	else counts.delete(key);
}

/** Adds (`sign` 1) or removes (`sign` -1) one document's properties from the tallies. */
export function tallyDocument(
	tallies: PropertyTallies,
	properties: Readonly<Record<string, ScannedFrontMatterProperty>>,
	sign: 1 | -1,
) {
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
				documentCount: 0,
			};
			tallies.set(id, tally);
		}
		tally.documentCount += sign;
		bump(tally.labelCounts, key, sign);
		bump(tally.typeCounts, property.type, sign);
		for (const option of scannedOptionValues(property))
			bump(tally.valueCounts, option, sign);
		if (tally.documentCount <= 0) tallies.delete(id);
	}
}

/** Fields from tallies, commonest first, then by label. */
export function fieldsFromTallies(tallies: PropertyTallies): PropertyField[] {
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

/**
 * One field per distinct (case-insensitive) front-matter key, typed from the
 * values. Ordered by how many documents carry it, then by label, so the
 * commonest properties lead the "add a column" menu.
 */
export function inferPropertyFields(
	propertiesByPath: PropertiesByPath,
): PropertyField[] {
	const tallies: PropertyTallies = new Map();
	for (const properties of Object.values(propertiesByPath))
		tallyDocument(tallies, properties, 1);
	return fieldsFromTallies(tallies);
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
		valuesByPath.set(path, rowValuesOf(properties, typeById));
	}
	return valuesByPath;
}

type ScannedProperties = Readonly<Record<string, ScannedFrontMatterProperty>>;

/**
 * Typed values per scanned-properties object. The scan keeps an unchanged
 * file's object across batches, so while its fields keep their types the
 * same values object comes back: the row merge downstream can then skip it.
 */
const rowValuesCache = new WeakMap<
	ScannedProperties,
	{ typeSignature: string; values: PropertyRowValues }
>();

function rowValuesOf(
	properties: ScannedProperties,
	typeById: ReadonlyMap<PropertyFieldId, FieldType>,
): PropertyRowValues {
	const entries: [
		PropertyFieldId,
		FieldType | undefined,
		ScannedFrontMatterProperty,
	][] = [];
	let typeSignature = "";
	for (const [key, property] of Object.entries(properties)) {
		const id = propertyFieldId(key);
		const type = typeById.get(id);
		typeSignature += `${type ?? "-"},`;
		entries.push([id, type, property]);
	}
	const cached = rowValuesCache.get(properties);
	if (cached?.typeSignature === typeSignature) return cached.values;
	const values: Partial<Record<PropertyFieldId, RowValue>> = {};
	for (const [id, type, property] of entries) {
		if (!type || id in values) continue;
		const value = toPropertyRowValue(property, type);
		if (value !== null) values[id] = value;
	}
	rowValuesCache.set(properties, { typeSignature, values });
	return values;
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
	/** Front-matter values only; built-ins are added per row by `withPropertyValues`. */
	valuesByPath: ReadonlyMap<string, PropertyRowValues>;
	/** Size / Word count per path, once read. */
	statsByPath: Readonly<Record<string, ScannedFileStats>>;
};

export const EMPTY_PROPERTY_MODEL: PropertyModel = {
	fields: [],
	valuesByPath: new Map(),
	statsByPath: {},
};

/** The listing rows and whole-file stats the built-in fields read. */
export type BuiltinFieldSource = {
	rows: readonly DocumentTableRow[];
	statsByPath: Readonly<Record<string, ScannedFileStats>>;
};

const EMPTY_BUILTIN_SOURCE: BuiltinFieldSource = { rows: [], statsByPath: {} };

/** Front-matter inference kept between scan batches, so a batch costs its changed files. */
type FrontMatterState = {
	source: PropertiesByPath;
	tallies: PropertyTallies;
	fields: PropertyField[];
	fieldsKey: string;
	values: Map<string, PropertyRowValues>;
	pathCount: number;
};

let frontMatterState: FrontMatterState | null = null;

/** Above this share of changed files, a full rebuild is cheaper than diffing. */
const FULL_REBUILD_SHARE = 0.3;

const typeKeyOf = (fields: readonly PropertyField[]) =>
	fields.map((field) => `${field.id}:${field.type}`).join("|");

function fullFrontMatterState(source: PropertiesByPath): FrontMatterState {
	const tallies: PropertyTallies = new Map();
	for (const properties of Object.values(source))
		tallyDocument(tallies, properties, 1);
	const fields = fieldsFromTallies(tallies);
	return {
		source,
		tallies,
		fields,
		fieldsKey: JSON.stringify(fields),
		values: buildPropertyRowValues(source, fields),
		pathCount: Object.keys(source).length,
	};
}

/**
 * Updates the previous batch's tallies and values for the paths whose scanned
 * object changed (the scan keeps unchanged files' objects). Same result as a
 * full rebuild; equal fields keep their array identity.
 */
function nextFrontMatterState(source: PropertiesByPath): FrontMatterState {
	const previous = frontMatterState;
	if (!previous) return fullFrontMatterState(source);
	if (previous.source === source) return previous;
	const changed: string[] = [];
	let total = 0;
	let added = 0;
	for (const path in source) {
		total++;
		const before = previous.source[path];
		if (before === source[path]) continue;
		changed.push(path);
		if (!before) added++;
	}
	// Same size and nothing new: nothing was removed, skip the second pass.
	if (total - added !== previous.pathCount) {
		for (const path in previous.source)
			if (!(path in source)) changed.push(path);
	}
	if (changed.length / Math.max(total, 1) > FULL_REBUILD_SHARE)
		return fullFrontMatterState(source);
	const { tallies } = previous;
	for (const path of changed) {
		const before = previous.source[path];
		const after = source[path];
		if (before) tallyDocument(tallies, before, -1);
		if (after) tallyDocument(tallies, after, 1);
	}
	const inferred = fieldsFromTallies(tallies);
	const fieldsKey = JSON.stringify(inferred);
	const fields = fieldsKey === previous.fieldsKey ? previous.fields : inferred;
	if (typeKeyOf(fields) !== typeKeyOf(previous.fields)) {
		return {
			source,
			tallies,
			fields,
			fieldsKey,
			values: buildPropertyRowValues(source, fields),
			pathCount: total,
		};
	}
	const typeById = new Map(fields.map((field) => [field.id, field.type]));
	const values = new Map(previous.values);
	for (const path of changed) {
		const properties = source[path];
		if (properties) values.set(path, rowValuesOf(properties, typeById));
		else values.delete(path);
	}
	return { source, tallies, fields, fieldsKey, values, pathCount: total };
}

const keyCounts = new WeakMap<object, number>();
function countKeys(record: object): number {
	let count = keyCounts.get(record);
	if (count === undefined) {
		count = 0;
		for (const _key in record) count++;
		keyCounts.set(record, count);
	}
	return count;
}

let modelMemo: {
	source: PropertiesByPath;
	builtinSource: BuiltinFieldSource;
	model: PropertyModel;
} | null = null;

/**
 * Inferred fields + typed values, memoized on the scan map's and the
 * listing's identity, and updated incrementally between scan batches.
 * Front-matter fields first, then the built-ins.
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
	frontMatterState = nextFrontMatterState(propertiesByPath);
	const { fields: frontMatterFields, values: frontMatterValues } =
		frontMatterState;
	const { rows, statsByPath } = builtinSource;
	const fields = [
		...frontMatterFields,
		...(rows.length > 0
			? builtinFields(rows, frontMatterFields, countKeys(statsByPath))
			: []),
	];
	const model =
		fields.length === 0
			? EMPTY_PROPERTY_MODEL
			: { fields, valuesByPath: frontMatterValues, statsByPath };
	modelMemo = { source: propertiesByPath, builtinSource, model };
	return model;
}

/** Test seam: forget the incremental state. */
export function resetPropertyModelMemo() {
	frontMatterState = null;
	modelMemo = null;
}
