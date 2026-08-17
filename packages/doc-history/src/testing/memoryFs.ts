import type { Compressor, DocHistoryFileSystem } from "../fs.js";

/**
 * In-memory fake filesystem used by every package-level test (R21's own
 * proof: the store must work with zero real disk I/O). Not exported from the
 * package's public entry points — test-only infrastructure.
 */
export interface MemoryFileSystem extends DocHistoryFileSystem {
	/** Direct access for tests that need to hand-corrupt or hand-write a file. */
	setRaw(path: string, data: Uint8Array): void;
	getRaw(path: string): Uint8Array | null;
}

function normalize(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "");
}

export function createMemoryFileSystem(): MemoryFileSystem {
	const files = new Map<string, Uint8Array>();
	const textEncoder = new TextEncoder();
	const textDecoder = new TextDecoder();

	return {
		async readFile(path) {
			const key = normalize(path);
			return files.has(key) ? (files.get(key) as Uint8Array) : null;
		},
		async writeFile(path, data) {
			files.set(normalize(path), data);
		},
		async appendText(path, text) {
			const key = normalize(path);
			const existing = files.get(key);
			const prior = existing ? textDecoder.decode(existing) : "";
			files.set(key, textEncoder.encode(prior + text));
		},
		async exists(path) {
			return files.has(normalize(path));
		},
		async mkdirRecursive() {
			// Directories are implicit in this in-memory model.
		},
		async listDir(dirPath) {
			const prefix = `${normalize(dirPath)}/`;
			const names = new Set<string>();
			for (const key of files.keys()) {
				if (!key.startsWith(prefix)) continue;
				const rest = key.slice(prefix.length);
				const name = rest.split("/")[0];
				if (name) names.add(name);
			}
			return [...names];
		},
		setRaw(path, data) {
			files.set(normalize(path), data);
		},
		getRaw(path) {
			const key = normalize(path);
			return files.has(key) ? (files.get(key) as Uint8Array) : null;
		},
	};
}

const FAKE_GZIP_MAGIC = new Uint8Array([0xfa, 0xde]);

/**
 * A trivial, reversible stand-in for real gzip: prefixes a magic header so
 * round-trips are provable and so tests can simulate a corrupt/placeholder
 * blob by writing bytes that lack it (see objectStore.test.ts's R28 cases).
 */
export function createFakeCompressor(): Compressor {
	return {
		async compress(data) {
			const out = new Uint8Array(FAKE_GZIP_MAGIC.length + data.byteLength);
			out.set(FAKE_GZIP_MAGIC, 0);
			out.set(data, FAKE_GZIP_MAGIC.length);
			return out;
		},
		async decompress(data) {
			const hasMagic =
				data.length >= FAKE_GZIP_MAGIC.length &&
				data[0] === FAKE_GZIP_MAGIC[0] &&
				data[1] === FAKE_GZIP_MAGIC[1];
			if (!hasMagic) {
				throw new Error(
					"Fake compressor: not a recognized blob (corrupt or placeholder)",
				);
			}
			return data.slice(FAKE_GZIP_MAGIC.length);
		},
	};
}
