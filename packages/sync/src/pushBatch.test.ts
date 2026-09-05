import { describe, expect, it } from "vitest";
import type { SyncBackend } from "./backend.js";
import { contentHash, type FileSystem, type LocalFile } from "./fs.js";
import {
	chunkPushOps,
	MAX_PUSH_BATCH_BYTES,
	MAX_PUSH_BATCH_FILES,
	MAX_PUSH_FILE_BYTES,
	sync,
} from "./sync.js";
import { SyncStateSchema } from "./types.js";

/**
 * DO row-read frequency fix, 2a: pushes go out in server-legal batches (one
 * version bump + one broadcast per batch) with a per-file fallback that
 * preserves the old error classification exactly.
 */

function memoryFs(seed: Record<string, string>): FileSystem & {
	files: Map<string, string>;
} {
	const files = new Map(Object.entries(seed));
	const key = (p: string) => {
		const slash = p.indexOf("/");
		return slash === -1 ? p : p.slice(slash + 1);
	};
	return {
		files,
		async readFile(p) {
			const hit = files.get(key(p));
			if (hit === undefined) throw new Error(`ENOENT ${p}`);
			return hit;
		},
		async writeFile(p, content) {
			files.set(key(p), content);
		},
		async deleteFile(p) {
			files.delete(key(p));
		},
		async readFileOrNull(p) {
			try {
				return await this.readFile(p);
			} catch {
				return null;
			}
		},
		async ensureDir() {},
		async listMarkdownFiles() {
			const out: LocalFile[] = [];
			for (const [relativePath, content] of [...files].sort()) {
				if (relativePath.startsWith(".hubble/")) continue;
				if (!relativePath.endsWith(".md")) continue;
				out.push({
					relativePath,
					content,
					hash: await contentHash(content),
					mtime: 1000,
					size: content.length,
				});
			}
			return out;
		},
		async readBinaryFile() {
			return new Uint8Array();
		},
		async writeBinaryFile() {},
		async listAssetFiles() {
			return [];
		},
		async listSidecarFiles() {
			return [];
		},
	};
}

function httpError(status: number, code: string, message: string) {
	return Object.assign(new Error(message), { status, code });
}

function pushOp(path: string, content: string) {
	return { path, hash: `hash-${path}`, content };
}

describe("chunkPushOps respects all three server caps", () => {
	it("packs by file count: 250 small files become 100/100/50", () => {
		const ops = Array.from({ length: 250 }, (_, i) =>
			pushOp(`f-${i}.md`, "small"),
		);
		const chunks = chunkPushOps(ops);
		expect(chunks).toHaveLength(3);
		expect(chunks.map((c) => (c.kind === "batch" ? c.ops.length : -1))).toEqual(
			[100, 100, 50],
		);
	});

	it("packs by total bytes: 1MiB files never exceed the 8MiB batch cap", () => {
		const oneMiB = "x".repeat(1024 * 1024);
		const ops = Array.from({ length: 20 }, (_, i) =>
			pushOp(`big-${i}.md`, oneMiB),
		);
		const chunks = chunkPushOps(ops);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.kind).toBe("batch");
			if (chunk.kind !== "batch") continue;
			expect(chunk.ops.length).toBeLessThanOrEqual(MAX_PUSH_BATCH_FILES);
			const bytes = chunk.ops.reduce(
				(sum, op) => sum + new TextEncoder().encode(op.content).length,
				0,
			);
			expect(bytes).toBeLessThanOrEqual(MAX_PUSH_BATCH_BYTES);
		}
		const total = chunks.reduce(
			(sum, c) => sum + (c.kind === "batch" ? c.ops.length : 0),
			0,
		);
		expect(total).toBe(20);
	});

	it("a file over the per-entry cap goes singly, never inside a batch", () => {
		const over = "x".repeat(MAX_PUSH_FILE_BYTES + 1);
		const chunks = chunkPushOps([
			pushOp("a.md", "small"),
			pushOp("huge.md", over),
			pushOp("b.md", "small"),
		]);
		expect(chunks).toHaveLength(3);
		expect(chunks[0]).toMatchObject({ kind: "batch" });
		expect(chunks[1]).toMatchObject({
			kind: "single",
			op: expect.objectContaining({ path: "huge.md" }),
		});
		expect(chunks[2]).toMatchObject({ kind: "batch" });
	});

	it("order is preserved and no chunk is ever empty", () => {
		const ops = Array.from({ length: 7 }, (_, i) => pushOp(`f-${i}.md`, "x"));
		const flat = chunkPushOps(ops).flatMap((c) =>
			c.kind === "batch" ? c.ops : [c.op],
		);
		expect(flat.map((op) => op.path)).toEqual(ops.map((op) => op.path));
		for (const chunk of chunkPushOps(ops)) {
			if (chunk.kind === "batch") expect(chunk.ops.length).toBeGreaterThan(0);
		}
		expect(chunkPushOps([])).toEqual([]);
	});
});

function batchHarness(
	seed: Record<string, string>,
	opts: {
		failBatch?: (files: string[]) => Error | null;
		failSingle?: (path: string) => Error | null;
	},
): {
	fs: FileSystem;
	backend: SyncBackend;
	batchCalls: string[][];
	singleCalls: string[];
	workspacePath: string;
} {
	const ws = "ws";
	const cloudSync = {
		provider: "cloudflare",
		deploymentUrl: "http://127.0.0.1:8787",
		workspaceId: "ws-1",
		deviceId: "d-1",
		backgroundSync: true,
	};
	const base = memoryFs({
		...seed,
		".hubble/config.json": JSON.stringify({ cloudSync }),
		".hubble/state.json": JSON.stringify({ lastSyncedAt: 1, files: {} }),
	});
	const batchCalls: string[][] = [];
	const singleCalls: string[] = [];
	const remote = new Map<string, { contentHash: string; content: string }>();
	let version = 1;
	const backend: SyncBackend = {
		async getWorkspace() {
			return "ws-1";
		},
		async createWorkspace() {
			return "ws-1";
		},
		async getFiles() {
			return [...remote.entries()].map(([path, f]) => ({
				_id: path,
				path,
				contentHash: f.contentHash,
				content: f.content,
				updatedAt: 1,
				deviceId: "other",
				deleted: false,
			}));
		},
		async pushFile(args) {
			singleCalls.push(args.path);
			const failure = opts.failSingle?.(args.path);
			if (failure) throw failure;
			remote.set(args.path, {
				contentHash: args.contentHash,
				content: args.content,
			});
		},
		async pushFilesBatch(args) {
			const paths = args.files.map((f) => f.path);
			batchCalls.push(paths);
			const failure = opts.failBatch?.(paths);
			if (failure) throw failure;
			for (const f of args.files) {
				remote.set(f.path, { contentHash: f.contentHash, content: f.content });
			}
			return ++version;
		},
		async softDeleteFile() {},
		async getAssets() {
			return [];
		},
		async pushAsset() {},
		async softDeleteAsset() {},
		async generateAssetUploadUrl() {
			return { url: "http://example.invalid" };
		},
		async getAssetDownloadUrl() {
			return null;
		},
	};
	return { fs: base, backend, batchCalls, singleCalls, workspacePath: ws };
}

async function readState(fs: FileSystem, ws: string) {
	const raw = await fs.readFile(`${ws}/.hubble/state.json`);
	return SyncStateSchema.parse(JSON.parse(raw));
}

describe("batched execute() matches the old per-file outcomes", () => {
	it("small files go out as batches — one broadcast-shaped call, all pushed", async () => {
		const seed: Record<string, string> = {};
		for (let i = 0; i < 5; i++) seed[`n-${i}.md`] = `content ${i}`;
		const { fs, backend, batchCalls, singleCalls, workspacePath } =
			batchHarness(seed, {});

		const result = await sync(backend, fs, workspacePath);
		expect(result.pushed.sort()).toEqual(
			["n-0.md", "n-1.md", "n-2.md", "n-3.md", "n-4.md"].sort(),
		);
		expect(result.failedFiles).toEqual([]);
		expect(batchCalls).toHaveLength(1);
		expect(batchCalls[0]!.sort()).toEqual(result.pushed.sort());
		expect(singleCalls).toEqual([]);
	});

	it("a failing batch chunk falls back to per-file pushes with identical classification", async () => {
		const seed: Record<string, string> = {
			"ok1.md": "one",
			"ok2.md": "two",
			"bad.md": "poison",
		};
		const { fs, backend, batchCalls, singleCalls, workspacePath } =
			batchHarness(seed, {
				failBatch: () => httpError(500, "UNKNOWN", "batch exploded"),
				failSingle: (path) =>
					path === "bad.md"
						? httpError(413, "FILE_TOO_LARGE", "File too large")
						: null,
			});

		const result = await sync(backend, fs, workspacePath);
		// Identical to the old per-file path: good files pushed, the poisoned
		// one permanently rejected — the batch error took down nothing.
		expect(result.pushed.sort()).toEqual(["ok1.md", "ok2.md"]);
		expect(result.failedFiles).toEqual([
			{
				path: "bad.md",
				permanent: true,
				code: "FILE_TOO_LARGE",
				message: "File too large",
			},
		]);
		expect(batchCalls).toHaveLength(1);
		expect(singleCalls.sort()).toEqual(["bad.md", "ok1.md", "ok2.md"]);
		const state = await readState(fs, workspacePath);
		expect(Object.keys(state.files).sort()).toEqual(["ok1.md", "ok2.md"]);
		expect(state.rejectedFiles?.["bad.md"]?.code).toBe("FILE_TOO_LARGE");
	});

	it("a transient batch failure retries every file singly and still converges", async () => {
		const seed: Record<string, string> = { "a.md": "aaa", "b.md": "bbb" };
		const { fs, backend, singleCalls, workspacePath } = batchHarness(seed, {
			failBatch: () => httpError(500, "UNKNOWN", "flaky batch"),
		});

		const result = await sync(backend, fs, workspacePath);
		expect(result.pushed.sort()).toEqual(["a.md", "b.md"]);
		expect(result.failedFiles).toEqual([]);
		expect(singleCalls.sort()).toEqual(["a.md", "b.md"]);
	});

	it("a file over the per-entry cap is pushed singly and still gets permanent-rejection handling", async () => {
		const huge = "x".repeat(MAX_PUSH_FILE_BYTES + 1);
		const seed: Record<string, string> = { "ok.md": "fine", "huge.md": huge };
		const { fs, backend, batchCalls, singleCalls, workspacePath } =
			batchHarness(seed, {
				failSingle: (path) =>
					path === "huge.md"
						? httpError(413, "FILE_TOO_LARGE", "File too large")
						: null,
			});

		const result = await sync(backend, fs, workspacePath);
		expect(result.pushed).toEqual(["ok.md"]);
		expect(result.failedFiles).toEqual([
			{
				path: "huge.md",
				permanent: true,
				code: "FILE_TOO_LARGE",
				message: "File too large",
			},
		]);
		// The oversized file never entered a batch — only the small file did.
		expect(batchCalls).toHaveLength(1);
		expect(batchCalls[0]).toEqual(["ok.md"]);
		expect(singleCalls).toEqual(["huge.md"]);
		const state = await readState(fs, workspacePath);
		expect(state.rejectedFiles?.["huge.md"]?.hash).toBe(
			await contentHash(huge),
		);
	});
});
