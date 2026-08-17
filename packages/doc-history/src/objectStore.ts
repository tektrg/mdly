import type { Compressor, DocHistoryFileSystem } from "./fs.js";
import { contentHash } from "./hash.js";
import { joinPath } from "./paths.js";

export interface ObjectStoreDeps {
	fs: DocHistoryFileSystem;
	compressor: Compressor;
}

export type ObjectReadResult =
	| { status: "ok"; bytes: Uint8Array }
	| { status: "unavailable" };

export interface WriteObjectResult {
	hash: string;
	/** Uncompressed size, in bytes — carried into the revision record. */
	bytes: number;
	/** False when a blob for this hash already existed (R1 dedupe by content). */
	created: boolean;
}

/** `<historyRoot>/objects/<hash[0:2]>/<hash>` (R1). */
export function objectPath(historyRoot: string, hash: string): string {
	return joinPath(historyRoot, "objects", hash.slice(0, 2), hash);
}

/**
 * Write-once, content-addressed blob store. An existing blob is never
 * rewritten — including when two unrelated documents hash to the same
 * content (QA5a) — because the write path always checks `exists` first.
 */
export async function writeObject(
	deps: ObjectStoreDeps,
	historyRoot: string,
	content: Uint8Array,
): Promise<WriteObjectResult> {
	const hash = await contentHash(content);
	const path = objectPath(historyRoot, hash);
	if (await deps.fs.exists(path)) {
		return { hash, bytes: content.byteLength, created: false };
	}
	const compressed = await deps.compressor.compress(content);
	await deps.fs.writeFile(path, compressed);
	return { hash, bytes: content.byteLength, created: true };
}

/**
 * Reads a blob back. Any failure to read or decompress it — including a
 * cloud-sync placeholder that is listed but not actually downloaded — is
 * surfaced as a typed "unavailable" result rather than a thrown error or
 * silently-empty content (R28), and never affects other revisions/blobs.
 */
export async function readObject(
	deps: ObjectStoreDeps,
	historyRoot: string,
	hash: string,
): Promise<ObjectReadResult> {
	try {
		const compressed = await deps.fs.readFile(objectPath(historyRoot, hash));
		if (compressed === null) return { status: "unavailable" };
		const bytes = await deps.compressor.decompress(compressed);
		return { status: "ok", bytes };
	} catch {
		return { status: "unavailable" };
	}
}
