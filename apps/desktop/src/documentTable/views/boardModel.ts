/**
 * Board (kanban) layout as plain data: one column per value of a select
 * field, plus a trailing "No <field>" column. Cards keep the order they
 * arrive in — the view's sort — so the board never has its own ordering to
 * persist.
 */
import type { FrontMatterEditValue } from "@mdly/workspace-kit/engine";
import type { DocumentTableRow } from "../documentTableView";
import {
	BOARD_COLUMN_COLORS,
	type BoardColumnColor,
	type BoardViewSettings,
	DEFAULT_BOARD_VIEW_SETTINGS,
} from "../properties/documentViews";
import {
	type PropertyField,
	type PropertyFieldId,
	propertyFieldId,
} from "../properties/propertyFields";

/** Cards rendered per column before "Show more"; keeps a 5k-note board cheap. */
export const BOARD_COLUMN_CARD_LIMIT = 100;

/**
 * Value columns shown before the rest fold into "Other". Also the most
 * distinct values a free-text field may have and still be offered as a board.
 */
export const BOARD_MAX_VALUE_COLUMNS = 30;

export type BoardColumnKind = "value" | "empty" | "other" | "unreadable";

export type BoardColumn = {
	/** Stable identity (React key, saved order/colour/hidden state). */
	key: string;
	kind: BoardColumnKind;
	/** The value a card dropped here gets; null = remove the key. Unused for "other"/"unreadable". */
	value: string | null;
	label: string;
	color: BoardColumnColor;
	/** Cards to render (capped), in the view's sort order. */
	rows: DocumentTableRow[];
	total: number;
};

export type BoardModel = {
	field: PropertyField;
	/** Shown columns, in display order. */
	columns: BoardColumn[];
	/** Columns folded into the hidden rail, in display order. */
	hiddenColumns: BoardColumn[];
};

export const EMPTY_COLUMN_KEY = "\u0000empty";
export const OTHER_COLUMN_KEY = "\u0000other";
export const UNREADABLE_COLUMN_KEY = "\u0000unreadable";

/**
 * The grouping form of a value: case, outer and repeated whitespace ignored,
 * so `DONE`, `done` and ` done ` are one column.
 */
export function normalizeGroupValue(value: string): string {
	return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function boardColumnKey(value: string | null): string {
	return value === null ? EMPTY_COLUMN_KEY : `v:${normalizeGroupValue(value)}`;
}

/** Every non-empty value a card has for `fieldId` (a list keeps its order). */
export function cardValues(
	row: DocumentTableRow,
	fieldId: PropertyFieldId,
): string[] {
	const value = row.properties?.[fieldId];
	if (value === null || value === undefined) return [];
	const list = Array.isArray(value) ? value : [String(value)];
	return list.map((item) => String(item).trim()).filter((item) => item !== "");
}

/** The single value a card has for `fieldId` (first tag of a list); null = none. */
export function cardValue(
	row: DocumentTableRow,
	fieldId: PropertyFieldId,
): string | null {
	return cardValues(row, fieldId)[0] ?? null;
}

const TITLE_FIELD_ID = propertyFieldId("title");

/** Card title: front-matter `title`, else the body's first `# H1`, else the file name. */
export function resolveCardTitle(
	row: DocumentTableRow,
	heading: string | null | undefined,
): string {
	const title = row.properties?.[TITLE_FIELD_ID];
	if (typeof title === "string" && title.trim().length > 0) {
		return title.trim();
	}
	if (heading && heading.trim().length > 0) return heading.trim();
	return row.name;
}

/** A column's colour before the user picks one: stable per key, grey for the special columns. */
export function defaultColumnColor(key: string): BoardColumnColor {
	if (!key.startsWith("v:")) return "gray";
	let hash = 0;
	for (let index = 0; index < key.length; index++) {
		hash = (hash * 31 + key.charCodeAt(index)) | 0;
	}
	// Skip grey: it marks the empty/unreadable columns.
	const palette = BOARD_COLUMN_COLORS.slice(1);
	return palette[Math.abs(hash) % palette.length] ?? "gray";
}

function distinctValueCount(
	rows: readonly DocumentTableRow[],
	fieldId: PropertyFieldId,
	stopAfter: number,
): number {
	const seen = new Set<string>();
	for (const row of rows) {
		const value = cardValue(row, fieldId);
		if (value === null) continue;
		seen.add(normalizeGroupValue(value));
		if (seen.size > stopAfter) break;
	}
	return seen.size;
}

/**
 * Fields a board can split on: every select, plus free text with at most
 * `BOARD_MAX_VALUE_COLUMNS` distinct values (prose would be a column per note).
 */
export function boardFieldCandidates(
	fields: readonly PropertyField[],
	rows: readonly DocumentTableRow[],
): PropertyField[] {
	return fields.filter(
		(field) =>
			field.type === "select" ||
			(field.type === "text" &&
				distinctValueCount(rows, field.id, BOARD_MAX_VALUE_COLUMNS) <=
					BOARD_MAX_VALUE_COLUMNS),
	);
}

/**
 * The field the board splits on: the view's choice when it is still a
 * candidate, else one named `status`, else the commonest select (free text is
 * only ever a board by explicit choice or by being named `status`).
 */
export function resolveBoardField(
	candidates: readonly PropertyField[],
	chosen: PropertyFieldId | null,
): PropertyField | null {
	return (
		candidates.find((field) => field.id === chosen) ??
		candidates.find((field) => field.id === propertyFieldId("status")) ??
		candidates.find((field) => field.type === "select") ??
		null
	);
}

type ValueBucket = {
	rows: DocumentTableRow[];
	/** Spelling -> cards using it; the commonest names the column. */
	spellings: Map<string, number>;
};

function commonestSpelling(spellings: Map<string, number>): string {
	let best = "";
	let bestCount = -1;
	for (const [spelling, count] of spellings) {
		if (count > bestCount) {
			best = spelling;
			bestCount = count;
		}
	}
	return best;
}

export type BuildBoardOptions = {
	/** Rendered cards per column key; `total` still counts every card. */
	limitFor?: (key: string) => number;
	/** Notes whose front matter could not be parsed: grouped apart, never moved. */
	invalidPaths?: ReadonlySet<string>;
	settings?: BoardViewSettings;
};

/**
 * Columns in the field's option order (most used first), then values seen on
 * the rows but missing from the options; values differing only by case or
 * whitespace share one column named by their commonest spelling. Past
 * `BOARD_MAX_VALUE_COLUMNS` the rest fold into "Other" (no drops); then the
 * empty column, then "Unreadable" when any note's front matter is broken.
 * The saved column order, hidden columns and colours are applied last.
 */
export function buildBoardModel(
	rows: readonly DocumentTableRow[],
	field: PropertyField,
	options: BuildBoardOptions = {},
): BoardModel {
	const limitFor = options.limitFor ?? (() => BOARD_COLUMN_CARD_LIMIT);
	const settings = options.settings ?? DEFAULT_BOARD_VIEW_SETTINGS;
	const invalidPaths = options.invalidPaths;
	const byKey = new Map<string, ValueBucket>();
	for (const option of field.options ?? []) {
		const key = boardColumnKey(option);
		if (!byKey.has(key)) byKey.set(key, { rows: [], spellings: new Map() });
	}
	const empty: DocumentTableRow[] = [];
	const unreadable: DocumentTableRow[] = [];
	for (const row of rows) {
		if (invalidPaths?.has(row.path)) {
			unreadable.push(row);
			continue;
		}
		const value = cardValue(row, field.id);
		if (value === null) {
			empty.push(row);
			continue;
		}
		const key = boardColumnKey(value);
		let bucket = byKey.get(key);
		if (!bucket) {
			bucket = { rows: [], spellings: new Map() };
			byKey.set(key, bucket);
		}
		bucket.rows.push(row);
		bucket.spellings.set(value, (bucket.spellings.get(value) ?? 0) + 1);
	}
	// An option no card uses any more still names its (empty) column.
	for (const option of field.options ?? []) {
		const bucket = byKey.get(boardColumnKey(option));
		if (bucket && bucket.spellings.size === 0) bucket.spellings.set(option, 0);
	}
	const colorOf = (key: string) =>
		settings.columnColors[key] ?? defaultColumnColor(key);
	const columns: BoardColumn[] = [];
	const other: DocumentTableRow[] = [];
	let otherValueCount = 0;
	for (const [key, bucket] of byKey) {
		if (columns.length >= BOARD_MAX_VALUE_COLUMNS) {
			other.push(...bucket.rows);
			otherValueCount += 1;
			continue;
		}
		const label = commonestSpelling(bucket.spellings);
		columns.push({
			key,
			kind: "value",
			value: label,
			label,
			color: colorOf(key),
			rows: bucket.rows.slice(0, limitFor(key)),
			total: bucket.rows.length,
		});
	}
	if (otherValueCount > 0) {
		columns.push({
			key: OTHER_COLUMN_KEY,
			kind: "other",
			value: null,
			label: `Other (${otherValueCount} values)`,
			color: colorOf(OTHER_COLUMN_KEY),
			rows: other.slice(0, limitFor(OTHER_COLUMN_KEY)),
			total: other.length,
		});
	}
	columns.push({
		key: EMPTY_COLUMN_KEY,
		kind: "empty",
		value: null,
		label: `No ${field.label}`,
		color: colorOf(EMPTY_COLUMN_KEY),
		rows: empty.slice(0, limitFor(EMPTY_COLUMN_KEY)),
		total: empty.length,
	});
	if (unreadable.length > 0) {
		columns.push({
			key: UNREADABLE_COLUMN_KEY,
			kind: "unreadable",
			value: null,
			label: "Unreadable",
			color: "gray",
			rows: unreadable.slice(0, limitFor(UNREADABLE_COLUMN_KEY)),
			total: unreadable.length,
		});
	}
	const ordered = orderColumns(columns, settings.columnOrder);
	const hidden = new Set(settings.hiddenColumns);
	const visible = settings.hideEmptyColumns
		? ordered.filter((column) => column.total > 0)
		: ordered;
	return {
		field,
		columns: visible.filter((column) => !hidden.has(column.key)),
		hiddenColumns: visible.filter((column) => hidden.has(column.key)),
	};
}

/** Saved order first (keys no longer present are skipped), the rest in natural order. */
export function orderColumns<T extends { key: string }>(
	columns: readonly T[],
	order: readonly string[],
): T[] {
	if (order.length === 0) return [...columns];
	const rank = new Map(order.map((key, index) => [key, index]));
	const placed = columns
		.filter((column) => rank.has(column.key))
		.sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));
	return [...placed, ...columns.filter((column) => !rank.has(column.key))];
}

/**
 * The saved order after dragging `key` before `beforeKey` (null = to the
 * end), over every column the board currently has (hidden ones included).
 */
export function reorderColumnKeys(
	allKeys: readonly string[],
	savedOrder: readonly string[],
	key: string,
	beforeKey: string | null,
): string[] {
	const current = orderColumns(
		allKeys.map((candidate) => ({ key: candidate })),
		savedOrder,
	)
		.map((column) => column.key)
		.filter((candidate) => candidate !== key);
	const index = beforeKey === null ? -1 : current.indexOf(beforeKey);
	if (index < 0) current.push(key);
	else current.splice(index, 0, key);
	return current;
}

/** A card's current value for the board field, as written back by Undo. */
export function rawBoardValue(
	row: DocumentTableRow,
	fieldId: PropertyFieldId,
): FrontMatterEditValue | null {
	const value = row.properties?.[fieldId];
	if (value === null || value === undefined) return null;
	if (Array.isArray(value)) return value.length > 0 ? value.map(String) : null;
	if (typeof value === "number" || typeof value === "boolean") return value;
	return String(value);
}

/**
 * The value a card gets when moved from `from` to `to`. A list only has the
 * source column's value swapped (others kept, no duplicates); moving to the
 * empty column drops it, and an emptied list removes the key. Null = remove.
 */
export function movedBoardValue(
	row: DocumentTableRow,
	fieldId: PropertyFieldId,
	from: Pick<BoardColumn, "kind" | "value">,
	to: Pick<BoardColumn, "kind" | "value">,
): FrontMatterEditValue | null {
	const raw = row.properties?.[fieldId];
	if (!Array.isArray(raw)) return to.value;
	const fromKey = from.value === null ? null : normalizeGroupValue(from.value);
	const next: string[] = [];
	const seen = new Set<string>();
	const push = (item: string) => {
		const key = normalizeGroupValue(item);
		if (key === "" || seen.has(key)) return;
		seen.add(key);
		next.push(item);
	};
	let replaced = false;
	for (const item of raw.map(String)) {
		if (fromKey !== null && normalizeGroupValue(item) === fromKey) {
			if (!replaced && to.value !== null) push(to.value);
			replaced = true;
			continue;
		}
		push(item);
	}
	if (!replaced && to.value !== null) {
		next.unshift(to.value);
		seen.add(normalizeGroupValue(to.value));
	}
	return next.length > 0 ? next : null;
}

/** Columns a card can be moved to (keyboard "Move to"): every droppable one but its own. */
export function moveTargetsFor(
	row: DocumentTableRow,
	model: BoardModel,
): BoardColumn[] {
	const current = boardColumnKey(cardValue(row, model.field.id));
	return [...model.columns, ...model.hiddenColumns].filter(
		(column) =>
			(column.kind === "value" || column.kind === "empty") &&
			column.key !== current,
	);
}
