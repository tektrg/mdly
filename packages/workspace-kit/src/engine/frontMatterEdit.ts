/**
 * Surgical front-matter edits: change ONE key's line(s) and leave every other
 * byte of the file alone (other keys, their order and quoting, comments, line
 * endings, BOM, the body).
 *
 * `setMarkdownFrontMatter` re-serializes the whole block, which is right for the
 * properties panel but wrong for a board drag: a drag must never reformat a
 * hand-written block. Anything this module cannot edit with certainty is
 * refused (`ok: false`) so the caller writes nothing.
 */
import { isMap, parseDocument } from "yaml";
import { isSimplePropertyKey } from "./frontMatter.js";

export type FrontMatterEditValue = string | number | boolean | string[];

export type FrontMatterEditResult =
	| { ok: true; text: string; changed: boolean }
	| { ok: false; reason: string };

type Line = { text: string; eol: string };

type BlockItem = {
	key: string;
	/** Index into the block's lines. */
	start: number;
	/** Exclusive end: continuation (indented) lines belong to the item. */
	end: number;
};

const BOM = "﻿";
const FENCE = /^---[ \t]*$/;
const KEY_LINE =
	/^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#'"\-?:][^:]*?|-[^\s:][^:]*?))[ \t]*:(?=[ \t]|$)/;

function refuse(reason: string): FrontMatterEditResult {
	return { ok: false, reason };
}

function splitLines(text: string): Line[] {
	const lines: Line[] = [];
	const pattern = /\r?\n/g;
	let start = 0;
	for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
		lines.push({ text: text.slice(start, match.index), eol: match[0] });
		start = match.index + match[0].length;
	}
	lines.push({ text: text.slice(start), eol: "" });
	return lines;
}

function joinLines(lines: readonly Line[]): string {
	return lines.map((line) => line.text + line.eol).join("");
}

function isTopLevelEntry(text: string): boolean {
	return text.length > 0 && !/^[ \t#]/.test(text);
}

function parseKey(lineText: string): { key: string; length: number } | null {
	const match = KEY_LINE.exec(lineText);
	if (!match) return null;
	const key =
		match[1] !== undefined
			? match[1]
			: match[2] !== undefined
				? match[2].replace(/''/g, "'")
				: (match[3] ?? "");
	return { key: key.trim(), length: match[0].length };
}

/** Top-level items of the block; null when a top-level line is not `key: …`. */
function blockItems(lines: readonly Line[]): BlockItem[] | null {
	const items: BlockItem[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const text = lines[index]?.text ?? "";
		// Obsidian writes lists at column 0 under their key: `tags:\n- a`.
		if (/^-(?:[ \t]|$)/.test(text) && items.length > 0) {
			(items[items.length - 1] as BlockItem).end = index + 1;
			continue;
		}
		if (!isTopLevelEntry(text)) {
			const previous = items[items.length - 1];
			// An indented line extends the item above it; blank lines and comments
			// do too only when more indented content follows (inside a block value).
			if (previous && /^[ \t]+\S/.test(text) && !/^[ \t]+#/.test(text)) {
				previous.end = index + 1;
			}
			continue;
		}
		const parsed = parseKey(text);
		if (!parsed) return null;
		items.push({ key: parsed.key, start: index, end: index + 1 });
	}
	return items;
}

/** Index where the value's trailing ` # comment` (or end) starts; -1 when unterminated. */
function valueEnd(value: string): number {
	const first = value[0];
	if (first === '"') {
		for (let index = 1; index < value.length; index += 1) {
			if (value[index] === "\\") index += 1;
			else if (value[index] === '"') return index + 1;
		}
		return -1;
	}
	if (first === "'") {
		for (let index = 1; index < value.length; index += 1) {
			if (value[index] !== "'") continue;
			if (value[index + 1] === "'") index += 1;
			else return index + 1;
		}
		return -1;
	}
	if (first === "[" || first === "{") {
		const close = first === "[" ? "]" : "}";
		let quote: string | null = null;
		for (let index = 1; index < value.length; index += 1) {
			const char = value[index];
			if (quote) {
				if (char === "\\" && quote === '"') index += 1;
				else if (char === quote) quote = null;
			} else if (char === '"' || char === "'") quote = char;
			else if (char === close) return index + 1;
		}
		return -1;
	}
	const comment = /[ \t]#/.exec(value);
	return (
		(comment ? comment.index : value.length) - trailingSpace(value, comment)
	);
}

function trailingSpace(value: string, comment: RegExpExecArray | null): number {
	const head = comment ? value.slice(0, comment.index) : value;
	return head.length - head.trimEnd().length;
}

type QuoteStyle = "plain" | "single" | "double";

function quoteStyleOf(rawValue: string): QuoteStyle {
	if (rawValue.startsWith('"')) return "double";
	if (rawValue.startsWith("'")) return "single";
	return "plain";
}

/** Reads back as exactly this string under the core schema. */
/** YAML 1.1 booleans/nulls: other tools (Obsidian, PyYAML) read these as non-strings. */
const YAML_11_SPECIAL = /^(?:y|yes|n|no|on|off|true|false|null|~)$/i;

function isSafePlain(value: string): boolean {
	if (value.length === 0 || value !== value.trim()) return false;
	if (YAML_11_SPECIAL.test(value)) return false;
	if (/[\r\n]/.test(value)) return false;
	const doc = parseDocument(`k: ${value}`, { schema: "core" });
	if (doc.errors.length > 0 || !isMap(doc.contents)) return false;
	return doc.get("k") === value;
}

function doubleQuoted(value: string): string {
	return JSON.stringify(value);
}

function formatString(value: string, style: QuoteStyle): string {
	if (style === "single" && !/[\r\n]/.test(value)) {
		return `'${value.replace(/'/g, "''")}'`;
	}
	if (style === "plain" && isSafePlain(value)) return value;
	return doubleQuoted(value);
}

function formatScalar(value: string | number | boolean, style: QuoteStyle) {
	if (typeof value === "string") return formatString(value, style);
	return String(value);
}

/** Inline value text; arrays stay inline (`[a, b]`). */
function formatInlineValue(
	value: FrontMatterEditValue,
	style: QuoteStyle,
): string {
	if (!Array.isArray(value)) return formatScalar(value, style);
	const items = value.map((item) =>
		isSafePlain(item) && !/[,[\]{}]/.test(item)
			? item
			: formatString(item, style === "single" ? "single" : "double"),
	);
	return `[${items.join(", ")}]`;
}

function lowerKey(key: string): string {
	return key.trim().toLowerCase();
}

/** `key: value` line for a value written inline. */
function replaceInlineValue(
	lineText: string,
	keyLength: number,
	value: FrontMatterEditValue,
): string | null {
	const afterKey = lineText.slice(keyLength);
	const spacing = /^[ \t]*/.exec(afterKey)?.[0] ?? "";
	const rawValue = afterKey.slice(spacing.length);
	const head = lineText.slice(0, keyLength);
	if (rawValue.length === 0 || rawValue.startsWith("#")) {
		// `key:` or `key: # note` — empty value; keep a trailing comment.
		const comment = rawValue.length > 0 ? ` ${rawValue}` : "";
		return `${head}${spacing || " "}${formatInlineValue(value, "plain")}${comment}`;
	}
	if (/^[|>&*!]/.test(rawValue)) return null;
	const end = valueEnd(rawValue);
	if (end < 0) return null;
	const tail = rawValue.slice(end);
	const style = Array.isArray(value)
		? quoteStyleOfList(rawValue)
		: quoteStyleOf(rawValue);
	return `${head}${spacing || " "}${formatInlineValue(value, style)}${tail}`;
}

function quoteStyleOfList(rawValue: string): QuoteStyle {
	const firstItem = rawValue.replace(/^\[\s*/, "");
	return quoteStyleOf(firstItem);
}

/** Block-list continuation lines (`  - a`) we can rewrite; null otherwise. */
function blockListIndent(continuation: readonly Line[]): string | null {
	let indent: string | null = null;
	for (const line of continuation) {
		const match = /^([ \t]*)- (.*)$/.exec(line.text);
		if (!match) return null;
		const item = match[2] ?? "";
		if (/^[|>&*!{[]/.test(item) || /[ \t]#/.test(item)) return null;
		if (indent === null) indent = match[1] ?? "";
		else if (indent !== match[1]) return null;
	}
	return indent;
}

function hasDuplicateKeys(items: readonly BlockItem[]): boolean {
	const seen = new Set<string>();
	for (const item of items) {
		const key = lowerKey(item.key);
		if (seen.has(key)) return true;
		seen.add(key);
	}
	return false;
}

function validateBlock(raw: string): string | null {
	const doc = parseDocument(raw, { schema: "core", uniqueKeys: false });
	if (doc.errors.length > 0) {
		return "The note's properties have a formatting mistake. Fix it in the note first.";
	}
	if (doc.contents !== null && !isMap(doc.contents)) {
		return "The note's properties aren't written as name: value lines.";
	}
	return null;
}

/** The value the edited block yields for `key` (case-insensitive), for the post-check. */
function readBack(raw: string, key: string): unknown {
	const doc = parseDocument(raw, { schema: "core", uniqueKeys: false });
	if (doc.errors.length > 0 || !isMap(doc.contents)) return undefined;
	const pair = doc.contents.items.find(
		(item) =>
			lowerKey(String((item.key as { value?: unknown })?.value)) === key,
	);
	if (!pair) return undefined;
	const node = pair.value as { toJSON?: () => unknown } | null;
	return node?.toJSON ? node.toJSON() : node;
}

function sameValue(actual: unknown, expected: FrontMatterEditValue | null) {
	if (expected === null) return actual === undefined;
	if (Array.isArray(expected)) {
		return (
			Array.isArray(actual) &&
			actual.length === expected.length &&
			actual.every((item, index) => item === expected[index])
		);
	}
	return actual === expected;
}

type SplitDocument = {
	bom: string;
	opening: Line;
	block: Line[];
	closing: Line;
	body: string;
};

function splitDocument(text: string): SplitDocument | "none" | "unclosed" {
	const bom = text.startsWith(BOM) ? BOM : "";
	const rest = text.slice(bom.length);
	const lines = splitLines(rest);
	const opening = lines[0];
	if (!opening || !FENCE.test(opening.text) || opening.eol === "") {
		return "none";
	}
	for (let index = 1; index < lines.length; index += 1) {
		const line = lines[index] as Line;
		if (!FENCE.test(line.text)) continue;
		return {
			bom,
			opening,
			block: lines.slice(1, index),
			closing: line,
			body: joinLines(lines.slice(index + 1)),
		};
	}
	return "unclosed";
}

function newlineOf(text: string): string {
	return /\r\n/.exec(text)?.[0] ?? "\n";
}

function createBlock(
	text: string,
	key: string,
	value: FrontMatterEditValue,
): string {
	const bom = text.startsWith(BOM) ? BOM : "";
	const eol = newlineOf(text);
	const line = `${key}: ${formatInlineValue(value, "plain")}`;
	return `${bom}---${eol}${line}${eol}---${eol}${text.slice(bom.length)}`;
}

function editLines(
	block: Line[],
	item: BlockItem,
	value: FrontMatterEditValue,
): Line[] | string {
	const keyLine = block[item.start] as Line;
	const parsedKey = parseKey(keyLine.text);
	if (!parsedKey)
		return "The note's properties aren't written as name: value lines.";
	const continuation = block.slice(item.start + 1, item.end);
	if (continuation.length === 0) {
		const nextText = replaceInlineValue(keyLine.text, parsedKey.length, value);
		if (nextText === null) {
			return `"${item.key}" spans several lines in this note, so it can only be changed in the note itself.`;
		}
		const next = [...block];
		next[item.start] = { ...keyLine, text: nextText };
		return next;
	}
	// `key:` followed by `  - a` lines: rewrite the list, keep the block style.
	const indent = blockListIndent(continuation);
	const keyRest = keyLine.text.slice(parsedKey.length).trim();
	if (indent === null || keyRest.length > 0 || !Array.isArray(value)) {
		return `"${item.key}" spans several lines in this note, so it can only be changed in the note itself.`;
	}
	const eol = keyLine.eol || newlineOf(joinLines(block));
	const lastEol = (block[item.end - 1] as Line).eol;
	const listLines: Line[] = value.map((entry, index) => ({
		text: `${indent}- ${formatString(entry, "plain")}`,
		eol: index === value.length - 1 ? lastEol : eol,
	}));
	if (listLines.length === 0) {
		const next = [...block];
		next.splice(item.start, item.end - item.start, {
			text: `${keyLine.text.slice(0, parsedKey.length)} []`,
			eol: lastEol,
		});
		return next;
	}
	const next = [...block];
	next.splice(item.start + 1, item.end - item.start - 1, ...listLines);
	return next;
}

function removeItem(block: Line[], item: BlockItem): Line[] {
	const next = [...block];
	next.splice(item.start, item.end - item.start);
	return next;
}

function appendItem(
	block: Line[],
	key: string,
	value: FrontMatterEditValue,
	eol: string,
): Line[] {
	const line = `${key}: ${formatInlineValue(value, "plain")}`;
	// Append after the last real line, before any trailing blank lines.
	let insertAt = block.length;
	while (insertAt > 0 && (block[insertAt - 1] as Line).text.trim() === "") {
		insertAt -= 1;
	}
	const next = [...block];
	next.splice(insertAt, 0, { text: line, eol });
	return next;
}

/**
 * Sets (or with `null`, removes) one front-matter key. The key matches
 * case-insensitively, like the property scan; a new key is written as given.
 * Every byte outside that key's line(s) is preserved. Refuses (and changes
 * nothing) on malformed YAML, duplicate keys, an unclosed block, or a value
 * shape it cannot rewrite with certainty.
 */
export function setFrontMatterValue(
	text: string,
	key: string,
	value: FrontMatterEditValue | null,
): FrontMatterEditResult {
	const targetKey = lowerKey(key);
	if (targetKey.length === 0) return refuse("The property has no name.");
	if (typeof value === "number" && !Number.isFinite(value)) {
		return refuse("That number can't be saved.");
	}
	const split = splitDocument(text);
	if (split === "unclosed") {
		return refuse(
			"The note's properties section is missing its closing --- line.",
		);
	}
	if (split === "none") {
		if (value === null) return { ok: true, text, changed: false };
		// `---` after blank lines: some tools read it as front matter. Never
		// put a second block in front of it.
		if (/^\uFEFF?(?:[ \t]*\r?\n)+---[ \t]*(?:\r?\n|$)/.test(text)) {
			return refuse(
				"The note's properties section doesn't start on the first line.",
			);
		}
		if (!isSimplePropertyKey(key.trim())) {
			return refuse(
				`"${key}" can't be used as a property name (letters, numbers, - and _ only).`,
			);
		}
		return {
			ok: true,
			text: createBlock(text, key.trim(), value),
			changed: true,
		};
	}

	const raw = joinLines(split.block);
	const invalid = validateBlock(raw);
	if (invalid) return refuse(invalid);
	const items = blockItems(split.block);
	if (!items)
		return refuse("The note's properties aren't written as name: value lines.");
	if (hasDuplicateKeys(items)) {
		return refuse(
			"The note lists the same property twice (it repeats a name). Remove one first.",
		);
	}
	const item = items.find((candidate) => lowerKey(candidate.key) === targetKey);

	let nextBlock: Line[];
	if (!item) {
		if (value === null) return { ok: true, text, changed: false };
		if (!isSimplePropertyKey(key.trim())) {
			return refuse(
				`"${key}" can't be used as a property name (letters, numbers, - and _ only).`,
			);
		}
		nextBlock = appendItem(split.block, key.trim(), value, split.opening.eol);
	} else if (value === null) {
		nextBlock = removeItem(split.block, item);
	} else {
		const edited = editLines(split.block, item, value);
		if (typeof edited === "string") return refuse(edited);
		nextBlock = edited;
	}

	const nextRaw = joinLines(nextBlock);
	if (
		validateBlock(nextRaw) ||
		!sameValue(readBack(nextRaw, targetKey), value)
	) {
		return refuse(
			"This change couldn't be checked safely, so nothing was saved.",
		);
	}
	const nextText =
		split.bom +
		joinLines([split.opening, ...nextBlock, split.closing]) +
		split.body;
	return { ok: true, text: nextText, changed: nextText !== text };
}
