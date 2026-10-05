import { parseMarkdownFrontMatter } from "@mdly/workspace-kit/engine";
import type {
	FrontMatterPropertyScan,
	FrontMatterPropertyScanOptions,
	ScannedFileStats,
	ScannedFrontMatterProperty,
} from "../src/desktopApi/types";
import { toScannedProperties } from "../src/documentTable/properties/scannedProperties";
import { readFileHead, scanFiles } from "./frontMatterTags";
import { countWords, readFileHeadAndStats } from "./fileWordCount";

/**
 * The property scan reads more than the tag scan: it keeps every key, so a
 * realistic property block (decision note: "~8 KB prefix") must fit whole.
 */
export const PROPERTY_HEAD_BYTES = 8192;

const OPENING_FENCE = /^(?:\uFEFF)?---[ \t]*\r?\n/;
const CLOSING_FENCE = /\r?\n---[ \t]*(?:\r?\n|$)/;

export type HeadPropertiesResult =
	| { kind: "none" }
	| { kind: "invalid" }
	| {
			kind: "properties";
			properties: Record<string, ScannedFrontMatterProperty>;
	  };

/**
 * One file head -> its supported properties. A block that opens but does not
 * close inside a full-size head was cut off by the read, so it is reported as
 * invalid instead of half-parsed (a truncated list would read as real values).
 */
export function extractHeadProperties(
	head: string,
	headBytes: number = PROPERTY_HEAD_BYTES,
): HeadPropertiesResult {
	const opening = head.match(OPENING_FENCE);
	if (!opening) return { kind: "none" };
	const afterOpening = head.slice(opening[0].length - 1);
	const isClosed = CLOSING_FENCE.test(afterOpening);
	if (!isClosed && Buffer.byteLength(head, "utf8") >= headBytes) {
		return { kind: "invalid" };
	}
	const parsed = parseMarkdownFrontMatter(head);
	if (parsed.type === "none") return { kind: "none" };
	if (parsed.type === "invalid") return { kind: "invalid" };
	const properties = toScannedProperties(parsed.properties);
	return Object.keys(properties).length === 0
		? { kind: "none" }
		: { kind: "properties", properties };
}

/** The front-matter block (fences included) at the top of `head`; "" when there is none or it never closes. */
export function frontMatterBlock(head: string): string {
	const opening = head.match(OPENING_FENCE);
	if (!opening) return "";
	const closing = CLOSING_FENCE.exec(head.slice(opening[0].length - 1));
	if (!closing) return "";
	return head.slice(0, opening[0].length - 1 + closing.index + closing[0].length);
}

type ScannedFile = { head: string; stats?: ScannedFileStats };

async function readScannedFile(
	path: string,
	includeStats: boolean,
): Promise<ScannedFile | null> {
	if (!includeStats) {
		const head = await readFileHead(path, PROPERTY_HEAD_BYTES);
		return head === null ? null : { head };
	}
	const read = await readFileHeadAndStats(path, PROPERTY_HEAD_BYTES);
	if (!read) return null;
	const frontMatterWords = countWords(frontMatterBlock(read.head));
	return {
		head: read.head,
		stats: {
			sizeBytes: read.sizeBytes,
			wordCount: Math.max(0, read.wordCount - frontMatterWords),
		},
	};
}

/**
 * Supported front-matter properties for each path, from bounded head reads
 * (whole-file streaming reads with `includeStats`, for Size / Word count).
 * Read-only by construction: nothing here opens a file for writing.
 */
export async function scanFrontMatterProperties(
	paths: readonly string[],
	options: FrontMatterPropertyScanOptions = {},
): Promise<FrontMatterPropertyScan> {
	const includeStats = options.includeStats === true;
	const propertiesByPath: FrontMatterPropertyScan["propertiesByPath"] = {};
	const statsByPath: Record<string, ScannedFileStats> = {};
	const invalidPaths: string[] = [];
	await scanFiles(
		paths,
		(path) => readScannedFile(path, includeStats),
		(path, file) => {
			if (file.stats) statsByPath[path] = file.stats;
			const result = extractHeadProperties(file.head);
			if (result.kind === "properties") {
				propertiesByPath[path] = result.properties;
			} else if (result.kind === "invalid") {
				invalidPaths.push(path);
			}
		},
	);
	return includeStats
		? { propertiesByPath, invalidPaths, statsByPath }
		: { propertiesByPath, invalidPaths };
}
