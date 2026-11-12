/**
 * One user-typed filter entry matched against a piece of text, always
 * case-insensitive (port of IndieLibKit's `TextPattern`, FastTab's rule):
 * - plain text: found anywhere in the text (`spec`),
 * - wildcard: has a `*` (any run of characters), found anywhere, unanchored
 *   (`memory/*`, `*spec*.md`). There is no `?` wildcard.
 * - regex: wrapped in slashes (`/^notes\//`). An invalid regex matches nothing
 *   and never throws.
 *
 * - lone star: an entry made only of `*` matches everything (no filter), so
 *   typing `*` on the way to `*.md` does not empty the list.
 *
 * A comma-separated list (`memory/*, *spec*.md`) is several entries, OR-ed.
 * Build a {@link CompiledTextPattern} once per query, then match many texts:
 * no regex is ever compiled per row.
 */

/** `/…/` with something between the slashes. */
export function isRegexEntry(entry: string): boolean {
	return entry.length > 2 && entry.startsWith("/") && entry.endsWith("/");
}

/** Has a `*` and something besides `*`, and is not a regex. */
export function isWildcardEntry(entry: string): boolean {
	return !isRegexEntry(entry) && entry.includes("*") && /[^*]/.test(entry);
}

/** Regex or wildcard (not plain text). */
export function isPatternEntry(entry: string): boolean {
	return isRegexEntry(entry) || isWildcardEntry(entry);
}

const escapeRegExp = (text: string) =>
	text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Compiled case-insensitive expression for a regex or wildcard entry; null for
 * plain text or a regex that does not compile.
 */
export function entryRegExp(entry: string): RegExp | null {
	if (isWildcardEntry(entry)) {
		return new RegExp(entry.split("*").map(escapeRegExp).join(".*"), "i");
	}
	if (!isRegexEntry(entry)) return null;
	try {
		return new RegExp(entry.slice(1, -1), "i");
	} catch {
		return null;
	}
}

/**
 * Trimmed entry (plain text and wildcards lowercased, regex kept as typed), or
 * null when empty, only `*`, or a regex that does not compile.
 */
export function normalizeEntry(entry: string): string | null {
	const trimmed = entry.trim();
	if (!/[^*]/.test(trimmed)) return null;
	if (isRegexEntry(trimmed)) return entryRegExp(trimmed) ? trimmed : null;
	return trimmed.toLowerCase();
}

/** Normalized entries, junk and duplicates dropped, order kept. */
export function cleanEntries(entries: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of entries) {
		const normalized = normalizeEntry(entry);
		if (normalized === null || seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

/**
 * A typed list → its entries, split on commas. An entry that starts with `/`
 * runs to the next `/` followed by a comma or the end, so a regex keeps its
 * commas (`docs/*, /a{1,3}/`). Otherwise falls back to a plain split.
 */
export function splitEntries(text: string): string[] {
	const trimmed = text.trim();
	if (isRegexEntry(trimmed)) return [trimmed];
	const out: string[] = [];
	let rest = trimmed;
	while (rest !== "") {
		rest = rest.trimStart();
		let entry: string;
		const regexEnd = rest.startsWith("/")
			? /^\/.+?\/(?=\s*(,|$))/.exec(rest)
			: null;
		if (regexEnd) {
			entry = regexEnd[0];
			rest = rest.slice(entry.length).replace(/^\s*,?/, "");
		} else {
			const comma = rest.indexOf(",");
			entry = comma === -1 ? rest : rest.slice(0, comma);
			rest = comma === -1 ? "" : rest.slice(comma + 1);
		}
		entry = entry.trim();
		if (entry !== "") out.push(entry);
	}
	return out;
}

type Matcher =
	| { kind: "plain"; needle: string }
	| { kind: "regex"; re: RegExp }
	| { kind: "never" }
	| { kind: "all" };

/** Entries compiled once, for matching many texts. */
export class CompiledTextPattern {
	readonly entries: readonly string[];
	private readonly matchers: readonly Matcher[];

	constructor(entries: readonly string[]) {
		this.entries = entries;
		this.matchers = entries.map((entry): Matcher => {
			if (/^\s*\*+\s*$/.test(entry)) return { kind: "all" };
			const re = entryRegExp(entry);
			if (re) return { kind: "regex", re };
			return isRegexEntry(entry)
				? { kind: "never" }
				: { kind: "plain", needle: entry.toLowerCase() };
		});
	}

	/** A typed comma-separated list, compiled. */
	static parse(text: string): CompiledTextPattern {
		return new CompiledTextPattern(splitEntries(text));
	}

	/** No entries: matches nothing. */
	get isEmpty(): boolean {
		return this.entries.length === 0;
	}

	/** Whether any entry matches `text`. */
	matches(text: string): boolean {
		let lower: string | null = null;
		for (const matcher of this.matchers) {
			if (matcher.kind === "all") return true;
			if (matcher.kind === "plain") {
				lower ??= text.toLowerCase();
				if (lower.includes(matcher.needle)) return true;
			} else if (matcher.kind === "regex") {
				if (matcher.re.test(text)) return true;
			}
		}
		return false;
	}

	/** Whether any entry matches any of the texts (null/undefined skipped). */
	matchesAnyOf(texts: readonly (string | null | undefined)[]): boolean {
		return texts.some((text) => text != null && this.matches(text));
	}
}

/** Whether `entry` matches `text`. Compiles each call; use the class for lists. */
export function matchesEntry(text: string, entry: string): boolean {
	return new CompiledTextPattern([entry]).matches(text);
}

/** Whether any entry matches `text`. */
export function matchesEntries(
	text: string,
	entries: readonly string[],
): boolean {
	return new CompiledTextPattern(entries).matches(text);
}
