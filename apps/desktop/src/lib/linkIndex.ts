import {
	basename,
	dirname,
	hasMarkdownExtension,
	joinPath,
	normalizePath,
} from "./filePath";
import {
	absoluteLinkPath,
	isLocalRelativeDestination,
	splitLinkDestination,
} from "./markdownLinkRewrite";

/**
 * Workspace link index: standard Markdown links `[text](rel/path.md#anchor)`
 * between workspace Markdown files. Forward links are stored per source; the
 * reverse (backlink) map is kept in step so a lookup is O(backlinks), not a
 * workspace sweep. Pure and mutable on purpose — the renderer store wraps it
 * and bumps a version on change, and step 2's graph view reads `linkGraph`.
 *
 * Wiki links `[[Note]]`, `[[Note|alias]]`, `[[Note#section]]`,
 * `[[folder/Note]]`, `[[Note.md]]` resolve to an indexed Markdown file (see
 * `resolveWikiTarget` for the rule); unresolved ones are not counted. Because
 * they match by file name, adding/removing/renaming a file re-resolves the
 * sources whose wiki targets share its name (`wikiByName`), so the index never
 * goes stale.
 *
 * Out of scope: embeds `![[…]]`, images, external URLs, links inside code.
 */

export type OutgoingLink = {
	/** Absolute, normalized target path as written (case preserved). */
	targetPath: string;
	/** Fragment after `#`, without the `#`, or null. */
	anchor: string | null;
	/** 1-based source line. */
	line: number;
	/** The source line around the link, trimmed for display. */
	snippet: string;
};

export type Backlink = OutgoingLink & { sourcePath: string };

/** A `[[…]]` reference as written; resolved against the index on demand. */
export type WikiRef = Omit<OutgoingLink, "targetPath"> & {
	/** Target path/name as written, without alias or `#section`. */
	target: string;
};

type SourceEntry = {
	path: string;
	mtime: number;
	/** Standard Markdown links (resolved at extraction). */
	mdLinks: OutgoingLink[];
	wikiRefs: WikiRef[];
	/** `mdLinks` + currently resolved wiki links — what `incoming` mirrors. */
	links: OutgoingLink[];
};

export type LinkIndex = {
	/** Workspace root for path-qualified wiki targets, if known. */
	root: string | null;
	/** Keyed by `pathKey(sourcePath)`. */
	sources: Map<string, SourceEntry>;
	/** Target key -> source keys that link to it. */
	incoming: Map<string, Set<string>>;
	/** Note name key -> indexed file keys with that name. */
	byName: Map<string, Set<string>>;
	/** Note name key -> source keys holding a wiki ref to that name. */
	wikiByName: Map<string, Set<string>>;
	/** Sources awaiting re-resolution while a batch is open (`batchLinkIndex`). */
	pending: Set<string> | null;
	/** Open `batchLinkIndex` calls; the last `end()` flushes `pending`. */
	batchDepth: number;
};

export type LinkGraph = {
	nodes: string[];
	edges: { source: string; target: string; count: number }[];
};

const SNIPPET_MAX = 160;

/** Case-insensitive identity, matching `pathEquals` and the move rewriter. */
export function pathKey(path: string): string {
	// Hot path: index paths are already normalized, so skip the re-split.
	const normalized =
		path.startsWith("/") && !NOT_NORMALIZED_RE.test(path)
			? path
			: normalizePath(path);
	return normalized.toLocaleLowerCase();
}

/** Anything `normalizePath` would change in an absolute path. */
const NOT_NORMALIZED_RE = /\\|\/\/|\/\.\.?(?:\/|$)|.\/$/;

/**
 * Blanks fenced code blocks and inline code spans (same length, newlines kept)
 * so link offsets and line numbers still line up with the original text.
 */
function maskCode(content: string): string {
	// Nothing to blank: no backtick and no `~~~` fence.
	if (!content.includes("`") && !content.includes("~~~")) return content;
	const lines = content.split("\n");
	let fence: string | null = null;
	const masked = lines.map((line) => {
		const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
		if (fence) {
			if (marker && marker[0] === fence[0] && marker.length >= fence.length)
				fence = null;
			return " ".repeat(line.length);
		}
		if (marker) {
			fence = marker;
			return " ".repeat(line.length);
		}
		return line.replace(/(`+)[^`]*?\1/g, (span) => " ".repeat(span.length));
	});
	return masked.join("\n");
}

function snippetAround(line: string, start: number, end: number): string {
	if (line.trim().length <= SNIPPET_MAX) return line.trim();
	const pad = Math.max(0, Math.floor((SNIPPET_MAX - (end - start)) / 2));
	const from = Math.max(0, start - pad);
	const to = Math.min(line.length, Math.max(end, from + SNIPPET_MAX));
	return `${from > 0 ? "…" : ""}${line.slice(from, to).trim()}${to < line.length ? "…" : ""}`;
}

function decode(path: string): string {
	try {
		return decodeURI(path);
	} catch {
		return path;
	}
}

/** Normalizes a reference label per CommonMark (case-fold, collapse spaces). */
function referenceLabel(label: string): string {
	return label.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** Takes the URL part of a destination: `<...>` or the first bare token. */
function destinationUrl(raw: string): string {
	const destination = raw.trim();
	const angled = destination.match(/^<([^>]+)>/);
	if (angled) return angled[1] ?? "";
	return destination.match(/^(\S+)/)?.[1] ?? "";
}

const REFERENCE_DEFINITION_RE = /^ {0,3}\[([^\]\n]+)\]:\s*(\S.*)$/;

/** Extracts resolved links to Markdown files from one document. */
export function extractMarkdownLinks(
	sourcePath: string,
	content: string,
): OutgoingLink[] {
	return markdownLinksIn(sourcePath, scanLines(content));
}

/** A document split once for both link scans: original + code-masked lines. */
type ScanLines = { original: string[]; masked: string[] };

function scanLines(content: string): ScanLines {
	const original = content.split("\n");
	const masked = maskCode(content);
	return {
		original,
		masked: masked === content ? original : masked.split("\n"),
	};
}

function markdownLinksIn(
	sourcePath: string,
	{ original, masked }: ScanLines,
): OutgoingLink[] {
	const links: OutgoingLink[] = [];
	// Reference definitions (`[label]: dest`) — first definition wins.
	const definitions = new Map<string, string>();
	const definitionLines = new Set<number>();
	masked.forEach((line, lineIndex) => {
		const def = line.match(REFERENCE_DEFINITION_RE);
		if (!def) return;
		definitionLines.add(lineIndex);
		const label = referenceLabel(def[1] ?? "");
		if (!definitions.has(label))
			definitions.set(label, destinationUrl(def[2] ?? ""));
	});
	const pushLink = (
		destination: string,
		lineIndex: number,
		start: number,
		length: number,
	) => {
		if (!isLocalRelativeDestination(destination)) return;
		const { path, suffix } = splitLinkDestination(destination);
		const decoded = decode(path);
		if (!hasMarkdownExtension(decoded)) return;
		const hash = suffix.indexOf("#");
		links.push({
			targetPath: absoluteLinkPath(sourcePath, decoded),
			anchor: hash >= 0 ? suffix.slice(hash + 1) || null : null,
			line: lineIndex + 1,
			snippet: snippetAround(original[lineIndex] ?? "", start, start + length),
		});
	};
	// Inline `[t](dest)`, full `[t][label]`, collapsed `[t][]`, shortcut `[t]`.
	const linkRe = /(!?)\[([^\]\n]*)\](?:\(([^)\n]+)\)|\[([^\]\n]*)\])?(?![(:])/g;
	masked.forEach((line, lineIndex) => {
		if (definitionLines.has(lineIndex)) return;
		for (const match of line.matchAll(linkRe)) {
			if (match[1]) continue; // image
			const start = match.index ?? 0;
			let destination: string | undefined;
			if (match[3] !== undefined) destination = destinationUrl(match[3]);
			else {
				const label = match[4] ? match[4] : (match[2] ?? "");
				destination = definitions.get(referenceLabel(label));
			}
			if (destination) pushLink(destination, lineIndex, start, match[0].length);
		}
	});
	return links;
}

const WIKI_LINK_RE = /(!?)\[\[([^\]\n]+)\]\]/g;

/**
 * Splits the inside of `[[…]]` the way the editor's parser
 * (`markdownToProsemirror` `textToPM`) does: alias after the first `|`, then
 * the section after the first `#`. `\|` (the pipe escaped inside a GFM table
 * cell, which the editor sees already unescaped) is the alias separator too.
 */
export function splitWikiLink(inner: string): {
	target: string;
	anchor: string | null;
} {
	const pipe = inner.indexOf("|");
	let raw = pipe >= 0 ? inner.slice(0, pipe) : inner;
	if (pipe > 0 && raw.endsWith("\\")) raw = raw.slice(0, -1);
	const hash = raw.indexOf("#");
	return {
		target: (hash >= 0 ? raw.slice(0, hash) : raw).trim(),
		anchor: hash >= 0 ? raw.slice(hash + 1).trim() || null : null,
	};
}

/** Extracts `[[…]]` references (code masked, embeds skipped). */
export function extractWikiRefs(content: string): WikiRef[] {
	return content.includes("[[") ? wikiRefsIn(scanLines(content)) : [];
}

function wikiRefsIn({ original, masked }: ScanLines): WikiRef[] {
	const refs: WikiRef[] = [];
	masked.forEach((line, lineIndex) => {
		if (!line.includes("[[")) return;
		for (const match of line.matchAll(WIKI_LINK_RE)) {
			if (match[1]) continue; // embed
			const { target, anchor } = splitWikiLink(match[2] ?? "");
			if (!target) continue;
			const start = match.index ?? 0;
			refs.push({
				target,
				anchor,
				line: lineIndex + 1,
				snippet: snippetAround(
					original[lineIndex] ?? "",
					start,
					start + match[0].length,
				),
			});
		}
	});
	return refs;
}

/** Note-name identity: base name without the Markdown extension, case-folded. */
export function wikiNameKey(path: string): string {
	// Bare names (most wiki targets) skip the path normalization.
	const name =
		path.includes("/") || path.includes("\\")
			? basename(normalizePath(path))
			: path;
	return name.replace(/\.(md|markdown)$/i, "").toLocaleLowerCase();
}

function addTo(map: Map<string, Set<string>>, key: string, value: string) {
	let set = map.get(key);
	if (!set) {
		set = new Set();
		map.set(key, set);
	}
	set.add(value);
}

function deleteFrom(map: Map<string, Set<string>>, key: string, value: string) {
	const set = map.get(key);
	set?.delete(value);
	if (set && set.size === 0) map.delete(key);
}

/**
 * Resolves a wiki target to an indexed file path, or null (Obsidian-like):
 *
 * 1. A target with a `/` is a path: tried relative to the workspace root, then
 *    relative to the source file's folder. No name fallback.
 * 2. Otherwise it matches indexed files by name, case-insensitively. Several
 *    files with that name: prefer one in the source's own folder, then the
 *    shortest path, then A→Z by case-folded path — deterministic for any
 *    indexing order.
 *
 * `.md` is implied; a target with another extension (`img.png`) only matches
 * a file literally named `img.png.md`, so attachments never resolve.
 */
export function resolveWikiTarget(
	index: LinkIndex,
	sourcePath: string,
	target: string,
): string | null {
	return resolveWikiTargetAmong(indexCandidates(index), sourcePath, target);
}

function indexCandidates(index: LinkIndex): WikiCandidates {
	return {
		root: index.root,
		pathFor: (key) => index.sources.get(key)?.path ?? null,
		keysNamed: (name) => index.byName.get(name) ?? [],
	};
}

/**
 * The files a wiki target can resolve against. `pathFor` maps a `pathKey` to
 * the file's real path; `keysNamed` lists the `pathKey`s of Markdown files
 * with a `wikiNameKey`.
 */
export type WikiCandidates = {
	root: string | null;
	pathFor: (key: string) => string | null;
	keysNamed: (name: string) => Iterable<string>;
};

/** Builds `WikiCandidates` from a plain file listing (non-Markdown skipped). */
export function wikiCandidatesFromPaths(
	root: string | null,
	paths: Iterable<string>,
): WikiCandidates {
	const byKey = new Map<string, string>();
	const byName = new Map<string, Set<string>>();
	for (const path of paths) {
		if (!hasMarkdownExtension(path)) continue;
		const key = pathKey(path);
		if (byKey.has(key)) continue;
		byKey.set(key, normalizePath(path));
		addTo(byName, wikiNameKey(path), key);
	}
	return {
		root: root ? normalizePath(root) : null,
		pathFor: (key) => byKey.get(key) ?? null,
		keysNamed: (name) => byName.get(name) ?? [],
	};
}

/** The single wiki resolution rule, shared by the index and the editor click. */
export function resolveWikiTargetAmong(
	candidates: WikiCandidates,
	sourcePath: string,
	target: string,
): string | null {
	const written = target.replace(/\\/g, "/");
	const file = hasMarkdownExtension(written) ? written : `${written}.md`;
	if (written.includes("/")) {
		const relative = file.replace(/^\/+/, "");
		const tries = [
			candidates.root
				? normalizePath(joinPath(candidates.root, relative))
				: null,
			file.startsWith("/") ? null : absoluteLinkPath(sourcePath, relative),
		];
		for (const candidate of tries) {
			const path = candidate && candidates.pathFor(pathKey(candidate));
			if (path) return path;
		}
		return null;
	}
	const keys = candidates.keysNamed(wikiNameKey(file));
	let sourceDir: string | null = null;
	let best: string | null = null;
	let bestRank: [number, number, string] | null = null;
	for (const key of keys) {
		if (best === null) {
			best = key; // ranked only once a second namesake shows up
			continue;
		}
		if (!bestRank) {
			sourceDir = pathKey(dirname(normalizePath(sourcePath)) ?? "");
			bestRank = [
				pathKey(dirname(best) ?? "") === sourceDir ? 0 : 1,
				best.length,
				best,
			];
		}
		const rank: [number, number, string] = [
			pathKey(dirname(key) ?? "") === sourceDir ? 0 : 1,
			key.length,
			key,
		];
		if (
			rank[0] < bestRank[0] ||
			(rank[0] === bestRank[0] &&
				(rank[1] < bestRank[1] ||
					(rank[1] === bestRank[1] && rank[2] < bestRank[2])))
		) {
			best = key;
			bestRank = rank;
		}
	}
	return best ? candidates.pathFor(best) : null;
}

export function createLinkIndex(root: string | null = null): LinkIndex {
	return {
		root: root ? normalizePath(root) : null,
		sources: new Map(),
		incoming: new Map(),
		byName: new Map(),
		wikiByName: new Map(),
		pending: null,
		batchDepth: 0,
	};
}

function detachIncoming(index: LinkIndex, key: string, links: OutgoingLink[]) {
	for (const link of links)
		deleteFrom(index.incoming, pathKey(link.targetPath), key);
}

/** Recomputes a source's resolved links from its md links + wiki refs. */
function resolveSource(index: LinkIndex, key: string) {
	const entry = index.sources.get(key);
	if (!entry) return;
	detachIncoming(index, key, entry.links);
	const links = [...entry.mdLinks];
	const candidates = entry.wikiRefs.length > 0 ? indexCandidates(index) : null;
	for (const ref of entry.wikiRefs) {
		const targetPath =
			candidates && resolveWikiTargetAmong(candidates, entry.path, ref.target);
		if (!targetPath) continue;
		const { target: _target, ...rest } = ref;
		links.push({ ...rest, targetPath });
	}
	if (entry.wikiRefs.length > 0) links.sort((a, b) => a.line - b.line);
	entry.links = links;
	for (const link of links)
		addTo(index.incoming, pathKey(link.targetPath), key);
}

/** Re-resolves every source whose wiki refs could match a file with `nameKey`. */
function reresolveDependents(index: LinkIndex, nameKey: string) {
	const dependents = index.wikiByName.get(nameKey);
	if (!dependents) return;
	for (const key of [...dependents]) {
		if (index.pending) index.pending.add(key);
		else resolveSource(index, key);
	}
}

/**
 * Opens a batch: name-driven re-resolution is deferred and done once per
 * affected source by the returned `end()`. A bulk sync uses this so N added
 * namesakes don't re-resolve the same linker N times. Batches nest; the
 * outermost `end()` flushes. Until `end()` runs,
 * other sources' wiki links may lag; call it in a `finally`.
 */
export function batchLinkIndex(index: LinkIndex): () => void {
	index.batchDepth += 1;
	index.pending ??= new Set();
	let ended = false;
	return () => {
		if (ended) return;
		ended = true;
		index.batchDepth -= 1;
		if (index.batchDepth > 0) return;
		const pending = index.pending;
		index.pending = null;
		for (const key of pending ?? []) resolveSource(index, key);
	};
}

function insertSource(
	index: LinkIndex,
	path: string,
	mtime: number,
	mdLinks: OutgoingLink[],
	wikiRefs: WikiRef[],
) {
	const normalized = normalizePath(path);
	const key = normalized.toLocaleLowerCase(); // = pathKey(path)
	const previous = index.sources.get(key);
	if (previous) {
		detachIncoming(index, key, previous.links);
		for (const ref of previous.wikiRefs)
			deleteFrom(index.wikiByName, wikiNameKey(ref.target), key);
	}
	index.sources.set(key, {
		path: normalized,
		mtime,
		mdLinks,
		wikiRefs,
		links: [],
	});
	for (const ref of wikiRefs)
		addTo(index.wikiByName, wikiNameKey(ref.target), key);
	// Only Markdown files are wiki targets (an indexed `.html` is not).
	if (!previous) {
		const nameKey = wikiNameKey(normalized);
		if (hasMarkdownExtension(path)) addTo(index.byName, nameKey, key);
		// A new file can win (or newly satisfy) other sources' wiki targets.
		reresolveDependents(index, nameKey);
	}
	if (index.pending && wikiRefs.length > 0) {
		// In a batch, wiki refs resolve once at `end()` (a later file in the
		// same sync may be the better namesake). Md links attach now.
		const entry = index.sources.get(key) as SourceEntry;
		entry.links = mdLinks;
		for (const link of mdLinks)
			addTo(index.incoming, pathKey(link.targetPath), key);
		index.pending.add(key);
		return;
	}
	resolveSource(index, key);
}

export function sourceMtime(index: LinkIndex, path: string): number | null {
	return index.sources.get(pathKey(path))?.mtime ?? null;
}

/** Removes a source's forward links and their reverse entries. */
export function removeLinkSource(index: LinkIndex, path: string) {
	const key = pathKey(path);
	const entry = index.sources.get(key);
	if (!entry) return;
	detachIncoming(index, key, entry.links);
	for (const ref of entry.wikiRefs)
		deleteFrom(index.wikiByName, wikiNameKey(ref.target), key);
	deleteFrom(index.byName, wikiNameKey(entry.path), key);
	index.sources.delete(key);
	// Wiki links that resolved to this file may now resolve to a namesake.
	reresolveDependents(index, wikiNameKey(entry.path));
}

/** (Re)indexes one document from its content. */
export function setLinkSource(
	index: LinkIndex,
	path: string,
	content: string,
	mtime: number,
) {
	// Split + mask once, shared by both scans; most notes have no `[[`.
	const lines = scanLines(content);
	insertSource(
		index,
		path,
		mtime,
		markdownLinksIn(path, lines),
		content.includes("[[") ? wikiRefsIn(lines) : [],
	);
}

/**
 * Moves a source. Pass `content` (the file after the move rewrite) to
 * re-resolve its relative links from the new folder; without it the old
 * resolved Markdown links are kept (wiki refs re-resolve from the new spot)
 * and the mtime is invalidated so the next sync re-reads it.
 */
export function renameLinkSource(
	index: LinkIndex,
	fromPath: string,
	toPath: string,
	content?: string,
) {
	const entry = index.sources.get(pathKey(fromPath));
	if (!entry) return;
	removeLinkSource(index, fromPath);
	if (content !== undefined) setLinkSource(index, toPath, content, entry.mtime);
	else insertSource(index, toPath, -1, entry.mdLinks, entry.wikiRefs);
}

/** Links pointing at `targetPath`, sorted by source path then line. Self-links excluded. */
export function backlinksFor(index: LinkIndex, targetPath: string): Backlink[] {
	const targetKey = pathKey(targetPath);
	const result: Backlink[] = [];
	for (const sourceKey of index.incoming.get(targetKey) ?? []) {
		if (sourceKey === targetKey) continue;
		const entry = index.sources.get(sourceKey);
		if (!entry) continue;
		for (const link of entry.links) {
			if (pathKey(link.targetPath) === targetKey)
				result.push({ ...link, sourcePath: entry.path });
		}
	}
	return result.sort(
		(a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.line - b.line,
	);
}

export function outgoingFor(
	index: LinkIndex,
	sourcePath: string,
): OutgoingLink[] {
	return index.sources.get(pathKey(sourcePath))?.links ?? [];
}

/**
 * Nodes + deduplicated edges for a set of files (e.g. a saved view's rows).
 * Edges whose ends are both in `paths` only; dangling links are dropped.
 * Node order follows `paths`; edge `count` is the number of link occurrences.
 */
export function linkGraph(
	index: LinkIndex,
	paths: readonly string[],
): LinkGraph {
	// First spelling wins, so a case-variant duplicate collapses to one node.
	const byKey = new Map<string, string>();
	for (const p of paths) if (!byKey.has(pathKey(p))) byKey.set(pathKey(p), p);
	const edges: LinkGraph["edges"] = [];
	for (const [sourceKey, source] of byKey) {
		const counts = new Map<string, number>();
		for (const link of index.sources.get(sourceKey)?.links ?? []) {
			const targetKey = pathKey(link.targetPath);
			if (targetKey === sourceKey || !byKey.has(targetKey)) continue;
			counts.set(targetKey, (counts.get(targetKey) ?? 0) + 1);
		}
		for (const [targetKey, count] of counts) {
			edges.push({ source, target: byKey.get(targetKey) as string, count });
		}
	}
	return { nodes: [...byKey.values()], edges };
}
