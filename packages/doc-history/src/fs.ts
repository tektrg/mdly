/**
 * Filesystem interface the rest of this package is written against (R21).
 * Nothing outside `fs-node.ts` may import a real Node/browser filesystem or
 * compression API directly, so a non-Electron/non-Node consumer can supply
 * its own implementation of these two small interfaces and reuse every other
 * module unchanged.
 */
export interface DocHistoryFileSystem {
	/** Reads a whole file as bytes, or null if it does not exist. */
	readFile(path: string): Promise<Uint8Array | null>;
	/** Writes bytes to a file, creating it if missing, overwriting if present. */
	writeFile(path: string, data: Uint8Array): Promise<void>;
	/** Appends UTF-8 text to a file, creating it if missing. Never truncates. */
	appendText(path: string, text: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	/** Creates a directory and all missing parents; no-op if it already exists. */
	mkdirRecursive(path: string): Promise<void>;
	/** Lists entry names directly inside a directory, or [] if it does not exist. */
	listDir(path: string): Promise<string[]>;
}

/** Gzip-style compression, isolated so the core never imports zlib directly. */
export interface Compressor {
	compress(data: Uint8Array): Promise<Uint8Array>;
	decompress(data: Uint8Array): Promise<Uint8Array>;
}
