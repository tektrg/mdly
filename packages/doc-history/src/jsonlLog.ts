import type { DocHistoryFileSystem } from "./fs.js";
import { joinPath } from "./paths.js";

/**
 * Shared low-level machinery for every append-only, fork-tolerant JSONL file
 * this package keeps (the per-document revision logs and the path↔id
 * index): finding a base file's cloud-sync-forked siblings, merging their
 * lines deduped by `id`, tolerating a truncated/non-JSON line anywhere, and
 * appending one line. Kept in one place so both `revisionLog.ts` and
 * `pathIndex.ts` share the exact same fork/merge/corruption-tolerance rules
 * (R5, R25) instead of re-implementing them.
 */
export interface JsonlEntry {
	id: string;
}

function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Sibling paths for `<dir>/<baseName>.jsonl`, plus forks like `<baseName> 2.jsonl`. */
export async function findJsonlSiblingPaths(
	fs: DocHistoryFileSystem,
	dir: string,
	baseName: string,
): Promise<string[]> {
	const names = await fs.listDir(dir);
	const pattern = new RegExp(`^${escapeForRegExp(baseName)}( \\d+)?\\.jsonl$`);
	return names
		.filter((name) => pattern.test(name))
		.map((name) => joinPath(dir, name));
}

function parseJsonlLine<T extends JsonlEntry>(line: string): T | null {
	const trimmed = line.trim();
	if (trimmed.length === 0) return null;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (
			parsed &&
			typeof parsed === "object" &&
			typeof (parsed as { id?: unknown }).id === "string"
		) {
			return parsed as T;
		}
		return null;
	} catch {
		// A truncated/non-JSON line (e.g. a crash mid-append) is silently
		// discarded rather than losing every other valid line (R25).
		return null;
	}
}

/** Reads and merges every sibling file, deduped by `id`. Order is unspecified. */
export async function readMergedJsonlEntries<T extends JsonlEntry>(
	fs: DocHistoryFileSystem,
	paths: string[],
): Promise<T[]> {
	const byId = new Map<string, T>();
	for (const path of paths) {
		const raw = await fs.readFile(path);
		if (raw === null) continue;
		const text = new TextDecoder().decode(raw);
		for (const line of text.split("\n")) {
			const entry = parseJsonlLine<T>(line);
			if (entry) byId.set(entry.id, entry);
		}
	}
	return [...byId.values()];
}

export async function appendJsonlLine(
	fs: DocHistoryFileSystem,
	path: string,
	entry: JsonlEntry,
): Promise<void> {
	await fs.appendText(path, `${JSON.stringify(entry)}\n`);
}
