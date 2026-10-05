import { parseMarkdownFrontMatter } from "@mdly/workspace-kit/engine";
import type {
	FrontMatterPropertyScan,
	ScannedFrontMatterProperty,
} from "../src/desktopApi/types";
import { toScannedProperties } from "../src/documentTable/properties/scannedProperties";
import { scanFileHeads } from "./frontMatterTags";

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

/**
 * Supported front-matter properties for each path, from bounded head reads.
 * Read-only by construction: nothing here opens a file for writing.
 */
export async function scanFrontMatterProperties(
	paths: readonly string[],
): Promise<FrontMatterPropertyScan> {
	const propertiesByPath: FrontMatterPropertyScan["propertiesByPath"] = {};
	const invalidPaths: string[] = [];
	await scanFileHeads(paths, PROPERTY_HEAD_BYTES, (path, head) => {
		const result = extractHeadProperties(head);
		if (result.kind === "properties") {
			propertiesByPath[path] = result.properties;
		} else if (result.kind === "invalid") {
			invalidPaths.push(path);
		}
	});
	return { propertiesByPath, invalidPaths };
}
