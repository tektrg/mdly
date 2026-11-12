import { hasMarkdownExtension, normalizePath } from "./filePath";
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
 * Out of scope: [[wikilinks]], images, external URLs, links inside code.
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

type SourceEntry = { path: string; mtime: number; links: OutgoingLink[] };

export type LinkIndex = {
	/** Keyed by `pathKey(sourcePath)`. */
	sources: Map<string, SourceEntry>;
	/** Target key -> source keys that link to it. */
	incoming: Map<string, Set<string>>;
};

export type LinkGraph = {
	nodes: string[];
	edges: { source: string; target: string; count: number }[];
};

const SNIPPET_MAX = 160;

/** Case-insensitive identity, matching `pathEquals` and the move rewriter. */
export function pathKey(path: string): string {
	return normalizePath(path).toLocaleLowerCase();
}

/**
 * Blanks fenced code blocks and inline code spans (same length, newlines kept)
 * so link offsets and line numbers still line up with the original text.
 */
function maskCode(content: string): string {
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
	const original = content.split("\n");
	const masked = maskCode(content).split("\n");
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

export function createLinkIndex(): LinkIndex {
	return { sources: new Map(), incoming: new Map() };
}

export function sourceMtime(index: LinkIndex, path: string): number | null {
	return index.sources.get(pathKey(path))?.mtime ?? null;
}

/** Removes a source's forward links and their reverse entries. */
export function removeLinkSource(index: LinkIndex, path: string) {
	const key = pathKey(path);
	const entry = index.sources.get(key);
	if (!entry) return;
	for (const link of entry.links) {
		const targetKey = pathKey(link.targetPath);
		const set = index.incoming.get(targetKey);
		set?.delete(key);
		if (set && set.size === 0) index.incoming.delete(targetKey);
	}
	index.sources.delete(key);
}

/** (Re)indexes one document from its content. */
export function setLinkSource(
	index: LinkIndex,
	path: string,
	content: string,
	mtime: number,
) {
	removeLinkSource(index, path);
	const key = pathKey(path);
	const links = extractMarkdownLinks(path, content);
	index.sources.set(key, { path: normalizePath(path), mtime, links });
	for (const link of links) {
		const targetKey = pathKey(link.targetPath);
		let set = index.incoming.get(targetKey);
		if (!set) {
			set = new Set();
			index.incoming.set(targetKey, set);
		}
		set.add(key);
	}
}

/**
 * Moves a source. Pass `content` (the file after the move rewrite) to
 * re-resolve its relative links from the new folder; without it the old
 * resolved targets are kept and the mtime is invalidated so the next sync
 * re-reads it.
 */
export function renameLinkSource(
	index: LinkIndex,
	fromPath: string,
	toPath: string,
	content?: string,
) {
	const entry = index.sources.get(pathKey(fromPath));
	if (!entry) return;
	if (content !== undefined) {
		removeLinkSource(index, fromPath);
		setLinkSource(index, toPath, content, entry.mtime);
		return;
	}
	const links = entry.links;
	removeLinkSource(index, fromPath);
	const key = pathKey(toPath);
	index.sources.set(key, { path: normalizePath(toPath), mtime: -1, links });
	for (const link of links) {
		const targetKey = pathKey(link.targetPath);
		const set = index.incoming.get(targetKey) ?? new Set<string>();
		set.add(key);
		index.incoming.set(targetKey, set);
	}
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
	const byKey = new Map(paths.map((p) => [pathKey(p), p]));
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
	return { nodes: [...paths], edges };
}
