import type { DocHistoryFileSystem } from "@mdly/doc-history";

export interface MemoryFileSystem extends DocHistoryFileSystem {
	getRaw(path: string): Uint8Array | null;
	setRaw(path: string, data: Uint8Array): void;
}

function normalize(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "");
}

export function createMemoryFileSystem(): MemoryFileSystem {
	const files = new Map<string, Uint8Array>();
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

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
			const prior = existing ? decoder.decode(existing) : "";
			files.set(key, encoder.encode(prior + text));
		},
		async exists(path) {
			return files.has(normalize(path));
		},
		async mkdirRecursive() {},
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
		getRaw(path) {
			const key = normalize(path);
			return files.has(key) ? (files.get(key) as Uint8Array) : null;
		},
		setRaw(path, data) {
			files.set(normalize(path), data);
		},
	};
}
