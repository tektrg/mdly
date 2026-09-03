import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SyncBackend } from "./backend.js";
import { contentHash, type FileSystem, type LocalFile } from "./fs.js";
import {
	countSubtreeWithEarlyBail,
	isOverPendingThreshold,
	isUnchangedByStat,
	matchesExcludedPattern,
	normalizeExcludedEntries,
	PENDING_BAIL_COUNT,
} from "./scope.js";
import {
	createThrottledProgress,
	execute,
	plan,
	summarizePlanByFolder,
	sync,
} from "./sync.js";
import { FileStateSchema } from "./types.js";

function memoryFs(seed: Record<string, string>): FileSystem & {
	mtimeOf: Record<string, number>;
	sizeOf: Record<string, number>;
} {
	const files = new Map(Object.entries(seed));
	const mtimeOf: Record<string, number> = {};
	const sizeOf: Record<string, number> = {};
	for (const [p, content] of files) {
		mtimeOf[p] = 1000;
		sizeOf[p] = content.length;
	}
	return {
		mtimeOf,
		sizeOf,
		async readFile(p) {
			const rel = p.split("/").slice(-1)[0];
			const hit = files.get(rel) ?? files.get(p);
			if (hit === undefined) throw new Error(`ENOENT ${p}`);
			return hit;
		},
		async writeFile(p, content) {
			const rel = p.split("/").slice(-1)[0];
			files.set(rel, content);
			mtimeOf[rel] = Date.now();
			sizeOf[rel] = content.length;
		},
		async deleteFile(p) {
			const rel = p.split("/").slice(-1)[0];
			files.delete(rel);
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
				if (relativePath === ".hubble/config.json") continue;
				if (relativePath === ".hubble/state.json") continue;
				if (!relativePath.endsWith(".md")) continue;
				out.push({
					relativePath,
					content,
					hash: await contentHash(content),
					mtime: mtimeOf[relativePath],
					size: sizeOf[relativePath],
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
	};
}

function configFs(
	extraState: Record<
		string,
		{ hash: string; lastSyncedAt: number; mtime?: number; size?: number }
	> = {},
	seed: Record<string, string> = {},
): FileSystem & { written: Record<string, string> } {
	const base = memoryFs(seed);
	const written: Record<string, string> = {};
	const cloudSync = {
		provider: "cloudflare",
		deploymentUrl: "http://127.0.0.1:8787",
		workspaceId: "ws-1",
		deviceId: "d-1",
		backgroundSync: true,
	};
	const state = {
		lastSyncedAt: 1,
		files: extraState,
	};
	return {
		...base,
		written,
		async readFileOrNull(p) {
			if (p.endsWith(".hubble/config.json"))
				return JSON.stringify({ cloudSync });
			if (p.endsWith(".hubble/state.json")) return JSON.stringify(state);
			return base.readFileOrNull(p);
		},
		async readFile(p) {
			if (p.endsWith(".hubble/config.json"))
				return JSON.stringify({ cloudSync });
			if (p.endsWith(".hubble/state.json")) return JSON.stringify(state);
			return base.readFile(p);
		},
		async writeFile(p, content) {
			written[p] = content;
			return base.writeFile(p, content);
		},
	};
}

function fakeBackend(seed: { path: string; content: string }[] = []): {
	backend: SyncBackend;
	pushed: string[];
} {
	const pushed: string[] = [];
	const files = new Map(
		seed.map((f) => [
			f.path,
			{
				_id: f.path,
				path: f.path,
				contentHash: `hash-${f.content}`,
				content: f.content,
				updatedAt: 1,
				deviceId: "other",
				deleted: false,
			},
		]),
	);
	return {
		pushed,
		backend: {
			async getWorkspace() {
				return "ws-1";
			},
			async createWorkspace() {
				return "ws-1";
			},
			async getFiles() {
				return [...files.values()];
			},
			async pushFile(args) {
				pushed.push(args.path);
				files.set(args.path, {
					_id: args.path,
					path: args.path,
					contentHash: args.contentHash,
					content: args.content,
					updatedAt: Date.now(),
					deviceId: args.deviceId,
					deleted: false,
				});
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
		},
	};
}

describe("plan → execute split (D-LW3)", () => {
	it("the dry-run preview and the real count come from the same plan() call", async () => {
		const { backend } = fakeBackend();
		const fsys = configFs({}, { "a.md": "hello", "b.md": "world" });

		const computed = await plan(backend, fsys, "/ws");
		expect(computed.toPush.map((p) => p.path).sort()).toEqual(["a.md", "b.md"]);
		expect(computed.totalOps).toBe(2);

		const result = await execute(computed, backend, fsys, "/ws");
		expect(result.pushed.sort()).toEqual(["a.md", "b.md"]);
		// The number shown before enabling is the number that happened.
		expect(result.pushed.length).toBe(computed.toPush.length);
	});

	it("sync() stays a thin wrapper over plan() + execute()", async () => {
		const { backend } = fakeBackend();
		const fsys = configFs({}, { "a.md": "hello" });
		const result = await sync(backend, fsys, "/ws");
		expect(result.pushed).toEqual(["a.md"]);
	});

	it("groups the plan by folder with byte counts for the review UI", () => {
		const summarized = summarizePlanByFolder({
			toPush: [
				{ path: "docs/a.md", hash: "h", content: "12345" },
				{ path: "docs/b.md", hash: "h", content: "12" },
			],
			toPull: [{ path: "top.md", hash: "h", content: "1" }],
		});
		expect(summarized).toEqual([
			{ folder: "docs", fileCount: 2, bytes: 7 },
			{ folder: "(root)", fileCount: 1, bytes: 1 },
		]);
	});
});

describe("progress throttling (never per file)", () => {
	it("emits O(ops/N)-not-O(ops) callbacks over a 100-file execute", async () => {
		const { backend } = fakeBackend();
		const seed: Record<string, string> = {};
		for (let i = 0; i < 100; i++) seed[`f${i}.md`] = `content ${i}`;
		const fsys = configFs({}, seed);
		const computed = await plan(backend, fsys, "/ws");
		expect(computed.toPush).toHaveLength(100);

		let calls = 0;
		await execute(computed, backend, fsys, "/ws", () => {
			calls++;
		});
		// everyN=20 → ~5 emissions + final flush. Per-file would be 100+.
		expect(calls).toBeLessThan(20);
		expect(calls).toBeGreaterThan(0);
	});

	it("createThrottledProgress always flushes the final 100%", async () => {
		const seen: number[] = [];
		const throttle = createThrottledProgress(
			(p) => {
				seen.push(p.done);
			},
			60_000,
			1_000_000,
		);
		for (let i = 0; i < 50; i++)
			throttle.emit({ phase: "push", done: i, total: 50 });
		// Throttled away: almost nothing emitted mid-run.
		expect(seen.length).toBeLessThan(5);
		throttle.flush({ phase: "done", done: 50, total: 50 });
		expect(seen[seen.length - 1]).toBe(50);
	});
});

describe("cheap change detection (mtime + size hint)", () => {
	it("FileStateSchema stays backward-compatible with state files lacking the fields", () => {
		expect(FileStateSchema.parse({ hash: "abc", lastSyncedAt: 1 })).toEqual({
			hash: "abc",
			lastSyncedAt: 1,
		});
	});

	it("a matching stat means 'might be unchanged' even without comparing hashes", () => {
		expect(
			isUnchangedByStat(
				{ hash: "h", lastSyncedAt: 1, mtime: 5, size: 9 },
				5,
				9,
			),
		).toBe(true);
		expect(
			isUnchangedByStat(
				{ hash: "h", lastSyncedAt: 1, mtime: 5, size: 9 },
				6,
				9,
			),
		).toBe(false);
		// Old state files without the fields never take the hint path.
		expect(isUnchangedByStat({ hash: "h", lastSyncedAt: 1 }, 5, 9)).toBe(false);
		// Missing local stat never takes the hint path either.
		expect(
			isUnchangedByStat(
				{ hash: "h", lastSyncedAt: 1, mtime: 5, size: 9 },
				undefined,
				9,
			),
		).toBe(false);
	});

	it("plan() treats a stat-matching file as unchanged (no push)", async () => {
		const content = "same content";
		const { backend } = fakeBackend([{ path: "a.md", content }]);
		// State hash matches remote; local stat matches state → unchanged via hint.
		const fsys = configFs(
			{
				"a.md": {
					hash: `hash-${content}`,
					lastSyncedAt: 1,
					mtime: 1000,
					size: content.length,
				},
			},
			{ "a.md": content },
		);
		const computed = await plan(backend, fsys, "/ws");
		expect(computed.toPush).toHaveLength(0);
		expect(computed.unchanged).toBe(1);
	});

	it("execute() persists mtime/size so the NEXT cycle can take the hint path", async () => {
		const { backend } = fakeBackend();
		const fsys = configFs({}, { "a.md": "hello" });
		const computed = await plan(backend, fsys, "/ws");
		await execute(computed, backend, fsys, "/ws");
		const stateWrites = Object.entries(fsys.written).filter(([p]) =>
			p.endsWith(".hubble/state.json"),
		);
		expect(stateWrites.length).toBeGreaterThan(0);
		const lastState = JSON.parse(
			stateWrites[stateWrites.length - 1]?.[1] ?? "{}",
		);
		expect(lastState.files["a.md"].mtime).toBeDefined();
		expect(lastState.files["a.md"].size).toBe(5);
	});
});

describe("path-or-name exclusions (gitignore convention)", () => {
	it("a bare name matches at any depth", () => {
		expect(
			matchesExcludedPattern("a/node_modules/b.md", ["node_modules"]),
		).toBe(true);
		expect(matchesExcludedPattern("node_modules/b.md", ["node_modules"])).toBe(
			true,
		);
		expect(matchesExcludedPattern("a/b.md", ["node_modules"])).toBe(false);
	});

	it("an entry with a separator is anchored to the workspace root", () => {
		expect(matchesExcludedPattern("fe/docs/a.md", ["fe/docs"])).toBe(true);
		expect(matchesExcludedPattern("other/fe/docs/a.md", ["fe/docs"])).toBe(
			false,
		);
		expect(matchesExcludedPattern("docs/a.md", ["fe/docs"])).toBe(false);
	});

	it("normalize keeps anchored paths, preserves a leading-slash anchor, dedupes", () => {
		expect(
			normalizeExcludedEntries([
				"  .claude ",
				"",
				"fe/docs",
				"fe/docs",
				"/dist/",
			]),
		).toEqual([".claude", "fe/docs", "/dist"]);
	});

	it("a leading slash anchors to the root (gitignore meaning), not any depth", () => {
		expect(matchesExcludedPattern("dist/a.md", ["/dist"])).toBe(true);
		expect(matchesExcludedPattern("a/dist/b.md", ["/dist"])).toBe(false);
		expect(matchesExcludedPattern("a/dist/b.md", ["dist"])).toBe(true);
	});
});

describe("pending-folder threshold (early bail at 1,001)", () => {
	it("bails instead of computing the exact number", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pending-bail-"));
		try {
			await fs.mkdir(path.join(root, "big"), { recursive: true });
			for (let i = 0; i < 12; i++)
				await fs.writeFile(path.join(root, "big", `f${i}.md`), "x");
			const count = countSubtreeWithEarlyBail(root, "big", 10);
			expect(count.bailed).toBe(true);
			expect(count.files).toBeGreaterThanOrEqual(10);
			// Never the exact number — "more than N" is the whole message.
			expect(count.files).toBeLessThan(12);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("the real 1,001 bail trips on a 1,050-file folder without counting to 1,050", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pending-real-"));
		try {
			await fs.mkdir(path.join(root, "huge"), { recursive: true });
			for (let i = 0; i < 1050; i++)
				await fs.writeFile(path.join(root, "huge", `f${i}.md`), "x");
			const count = countSubtreeWithEarlyBail(root, "huge");
			expect(count.bailed).toBe(true);
			expect(count.files).toBe(PENDING_BAIL_COUNT);
			expect(isOverPendingThreshold(count)).toBe(true);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 30000);

	it("a small folder stays under threshold", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pending-small-"));
		try {
			await fs.mkdir(path.join(root, "tiny"), { recursive: true });
			await fs.writeFile(path.join(root, "tiny", "a.md"), "x");
			const count = countSubtreeWithEarlyBail(root, "tiny");
			expect(count.bailed).toBe(false);
			expect(isOverPendingThreshold(count)).toBe(false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("directory count alone trips the threshold (900 files across 4,000 folders kills the app)", () => {
		expect(isOverPendingThreshold({ files: 900, dirs: 4000 })).toBe(true);
		expect(isOverPendingThreshold({ files: 5000, dirs: 3 })).toBe(true);
		expect(isOverPendingThreshold({ files: 10, dirs: 10 })).toBe(false);
	});
});
