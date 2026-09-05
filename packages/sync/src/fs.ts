export type LocalFile = {
	relativePath: string;
	content: string;
	hash: string;
	/** Cheap-stat hint fields (populated by the Node fs) — lets plan() treat an unchanged stat as "might be unchanged" without trusting it as proof. */
	mtime?: number;
	size?: number;
};

export type LocalAsset = {
	relativePath: string;
	hash: string;
	mtime?: number;
	size?: number;
};

/** Platform-agnostic filesystem interface for sync operations */
export interface FileSystem {
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string): Promise<void>;
	deleteFile(path: string): Promise<void>;
	readFileOrNull(path: string): Promise<string | null>;
	ensureDir(path: string): Promise<void>;
	listMarkdownFiles(dir: string): Promise<LocalFile[]>;
	/**
	 * Comment logs + history index shards (`.mdly/comments/**` +
	 * `.mdly/history/index*.jsonl`), with full content like
	 * `listMarkdownFiles`. Deliberately NOT subject to `excludedFolders` —
	 * the desktop default list contains `.mdly`, which would otherwise
	 * silently return nothing forever. Wired into plan()/execute() (Rounds
	 * 3–4); nothing about note/asset sync behaviour changes by adding it.
	 */
	listSidecarFiles(dir: string): Promise<LocalFile[]>;
	readBinaryFile(path: string): Promise<Uint8Array>;
	writeBinaryFile(path: string, data: Uint8Array): Promise<void>;
	listAssetFiles(dir: string): Promise<LocalAsset[]>;
}

/** Minimal filesystem subset needed for init/config operations */
export type InitFileSystem = Pick<
	FileSystem,
	"readFile" | "readFileOrNull" | "writeFile" | "ensureDir"
>;

/** Isomorphic SHA-256 using Web Crypto API (works in browser + Node 20+) */
export async function contentHash(
	content: string | Uint8Array,
): Promise<string> {
	const data =
		typeof content === "string" ? new TextEncoder().encode(content) : content;
	const hash = await crypto.subtle.digest("SHA-256", data);
	const bytes = new Uint8Array(hash);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
