import fs from "node:fs/promises";
import { parseMarkdownFrontMatter } from "@mdly/workspace-kit/engine";

/**
 * Front matter is always at the very top of a file, so the scan reads only this
 * much of each one. Keeps a workspace-wide scan proportional to the file
 * *count*, not to total workspace size -- a 40 MB note costs the same as a 2 KB
 * one. Generous enough for a realistic property block.
 */
export const FRONT_MATTER_HEAD_BYTES = 4096;

/** Files read at once. Bounded so a large workspace can't exhaust file handles. */
const SCAN_CONCURRENCY = 16;

/** The front matter key treated as tags. Matched case-insensitively. */
const TAGS_KEY = "tags";

/**
 * Reads the first chunk of a file. Returns null when the file has gone away or
 * can't be read -- a workspace scan must never fail as a whole because one file
 * was deleted or is unreadable mid-scan.
 */
async function readHead(path: string): Promise<string | null> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(path, "r");
		const buffer = Buffer.allocUnsafe(FRONT_MATTER_HEAD_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => {});
	}
}

/** Pulls the `tags:` front matter values out of one file's head text. */
export function extractFrontMatterTags(head: string): string[] {
	const parsed = parseMarkdownFrontMatter(head);
	if (parsed.type !== "valid") return [];
	for (const property of parsed.properties) {
		if (property.key.toLowerCase() !== TAGS_KEY) continue;
		if (property.type !== "tags") return [];
		return property.value.filter((tag) => tag.trim().length > 0);
	}
	return [];
}

/**
 * Maps each given file path to the tags declared in its front matter, skipping
 * files that declare none. Runs bounded-concurrency head reads rather than
 * loading whole files, so it stays off the critical path of workspace
 * discovery (which deliberately never opens files at all -- see ADR-0008).
 */
export async function scanFrontMatterTags(
	paths: readonly string[],
): Promise<Record<string, string[]>> {
	const tagsByPath: Record<string, string[]> = {};
	let cursor = 0;

	async function worker() {
		while (cursor < paths.length) {
			const path = paths[cursor++];
			if (!path) continue;
			const head = await readHead(path);
			if (head === null) continue;
			const tags = extractFrontMatterTags(head);
			if (tags.length > 0) tagsByPath[path] = tags;
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(SCAN_CONCURRENCY, paths.length) }, worker),
	);
	return tagsByPath;
}
