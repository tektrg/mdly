import { InvalidPathError } from "./durableObject/errors.js";

/**
 * THE RULE (round 4): a client-supplied path is stored byte-for-byte as
 * normalised here, or the request is rejected. The server NEVER silently
 * rewrites a path — no trimming, no whitespace rejection. Leading/trailing
 * spaces are legal in filenames on macOS/Linux, and the writer and the
 * garbage collector's reference matcher must agree exactly, or the GC
 * deletes live images.
 *
 * Structural normalisation only — collapsing `.`, resolving `..`, `\` to
 * `/`, doubled slashes. Performed by this ONE function, called by EVERY
 * consumer: file pushes, file deletes, batch pushes, asset pushes, asset
 * deletes, and the GC matcher (`referencedAssetPaths` in `orphanAssets.ts`).
 *
 * Returns `null` when the path escapes the workspace root (`..` with nothing
 * to pop). Returns `""` for an empty path or one made only of skippable
 * segments. Byte-preserving within segments: `"note.assets/ shot.png"` and
 * `"note.assets/shot.png"` are different files and stay different.
 *
 * Moved here from `orphanAssets.ts` so the write path and the GC scan share
 * one implementation — never a second copy.
 */
export function normalizeWorkspacePath(path: string): string | null {
	const parts: string[] = [];
	for (const part of path.replaceAll("\\", "/").split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) return null; // escapes the workspace root
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return parts.join("/");
}

// Characters that may never appear in a stored path: C0 controls (includes
// NUL) + DEL, zero-width space, BOM, bidi controls. Built from escapes (not
// literals) so no invisible character ever hides in this source line.
// ZWJ/ZWNJ (U+200C/U+200D) are deliberately ALLOWED: legitimate in
// Persian/Arabic filenames and emoji sequences. NUL in particular must never
// be stored -- Node's `fs` throws on it and one poisoned row breaks the
// desktop client's write loop on every sync.
const FORBIDDEN_PATH_CHARS = new RegExp(
	"[" +
		"\u0000-\u001F" + // C0 controls, includes NUL
		"\u007F" + // DEL
		"\u200B" + // zero-width space
		"\uFEFF" + // BOM / zero-width no-break space
		"\u200E\u200F" + // bidi marks
		"\u202A-\u202E" + // bidi embeddings/overrides
		"\u2066-\u2069" +
		"]"
);

/** True when the value contains characters forbidden in stored paths/ids. */
export function containsForbiddenChars(value: string): boolean {
	return FORBIDDEN_PATH_CHARS.test(value);
}

/** Maximum total path length accepted on the write path. */
export const MAX_PATH_LENGTH = 1024;

/**
 * The single chokepoint for every incoming file/asset path before any
 * invariant check or write: normalise structurally, validate, then return
 * the normalised form to store and match. Throws `InvalidPathError`
 * (→ HTTP 400) for non-strings, root-escaping paths, empty results,
 * forbidden characters, and over-long paths. Never rewrites beyond the
 * structural step both writer and GC share.
 */
export function canonicalFilePath(path: unknown): string {
	if (typeof path !== "string") {
		throw new InvalidPathError(typeof path);
	}
	const canonical = normalizeWorkspacePath(path);
	if (!canonical) {
		throw new InvalidPathError(path);
	}
	if (canonical.length > MAX_PATH_LENGTH) {
		throw new InvalidPathError(path);
	}
	if (containsForbiddenChars(canonical)) {
		throw new InvalidPathError(path);
	}
	return canonical;
}
