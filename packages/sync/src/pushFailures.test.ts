import { describe, expect, it } from "vitest";
import type { SyncBackend } from "./backend.js";
import { contentHash, type FileSystem, type LocalFile } from "./fs.js";
import { plan, sync } from "./sync.js";
import { SyncStateSchema } from "./types.js";

/**
 * Blocker 2 (client): one file's push failure must not abort the sync run.
 * Permanent failures (HTTP 413 — the file can never fit) are recorded,
 * skipped while unchanged, and reported every run; transient ones (5xx,
 * network) are reported and retried next run. State is always written so
 * other files' progress is durable.
 */

function memoryFs(seed: Record<string, string>): FileSystem & {
	files: Map<string, string>;
} {
	const files = new Map(Object.entries(seed));
	// Runtime paths arrive as `<workspace>/<relative>`; seeds are relative.
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

function harness(
	seed: Record<string, string>,
	pushImpl: (path: string) => Promise<void> | void,
): {
	fs: FileSystem;
	backend: SyncBackend;
	pushed: string[];
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
	const pushed: string[] = [];
	const remote = new Map<string, { contentHash: string; content: string }>();
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
			await pushImpl(args.path);
			pushed.push(args.path);
			remote.set(args.path, {
				contentHash: args.contentHash,
				content: args.content,
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
	};
	return { fs: base, backend, pushed, workspacePath: ws };
}

async function readState(fs: FileSystem, ws: string) {
	const raw = await fs.readFile(`${ws}/.hubble/state.json`);
	return SyncStateSchema.parse(JSON.parse(raw));
}

describe("one file's push failure never aborts the run", () => {
	it("a permanently-rejected (413) note is skipped-but-reported while every other file syncs, across runs", async () => {
		const big = "x".repeat(100);
		const { fs, backend, pushed, workspacePath } = harness(
			{ "ok1.md": "one", "ok2.md": "two", "big.md": big },
			(path) => {
				if (path === "big.md") {
					throw httpError(413, "FILE_TOO_LARGE", "File too large");
				}
			},
		);

		// Run 1 succeeds overall: others pushed, state written, failure reported.
		const run1 = await sync(backend, fs, workspacePath);
		expect(run1.pushed.sort()).toEqual(["ok1.md", "ok2.md"]);
		expect(run1.failedFiles).toEqual([
			{
				path: "big.md",
				permanent: true,
				code: "FILE_TOO_LARGE",
				message: "File too large",
			},
		]);

		const state1 = await readState(fs, workspacePath);
		expect(state1.lastSyncedAt).toBeGreaterThan(0);
		expect(Object.keys(state1.files).sort()).toEqual(["ok1.md", "ok2.md"]);
		expect(state1.rejectedFiles?.["big.md"]?.hash).toBe(await contentHash(big));

		// Run 2 also succeeds: big.md is NOT re-pushed, still reported.
		const pushedBefore = pushed.length;
		const run2 = await sync(backend, fs, workspacePath);
		expect(pushed.length).toBe(pushedBefore);
		expect(run2.failedFiles).toEqual([
			{
				path: "big.md",
				permanent: true,
				code: "FILE_TOO_LARGE",
				message: "File too large",
			},
		]);
	});

	it("a transient (5xx) failure is reported and retried on the next run", async () => {
		let flakyFails = true;
		const { fs, backend, pushed, workspacePath } = harness(
			{ "ok.md": "fine", "flaky.md": "retry me" },
			(path) => {
				if (path === "flaky.md" && flakyFails) {
					throw httpError(500, "UNKNOWN", "Internal error.");
				}
			},
		);

		const run1 = await sync(backend, fs, workspacePath);
		expect(run1.pushed).toEqual(["ok.md"]);
		expect(run1.failedFiles).toEqual([
			{
				path: "flaky.md",
				permanent: false,
				code: "UNKNOWN",
				message: "Internal error.",
			},
		]);
		const state1 = await readState(fs, workspacePath);
		expect(state1.files["flaky.md"]).toBeUndefined();
		expect(state1.rejectedFiles?.["flaky.md"]).toBeUndefined();

		flakyFails = false;
		const run2 = await sync(backend, fs, workspacePath);
		expect(run2.failedFiles).toEqual([]);
		expect(pushed).toContain("flaky.md");
		const state2 = await readState(fs, workspacePath);
		expect(state2.files["flaky.md"]?.hash).toBe(await contentHash("retry me"));
	});

	it("an edited-then-fitting file clears its rejection and syncs", async () => {
		const gate = { reject: true };
		const seed: Record<string, string> = {
			"ok.md": "fine",
			"big.md": "x".repeat(100),
		};
		const built = harness(seed, (path) => {
			if (path === "big.md" && gate.reject) {
				throw httpError(413, "FILE_TOO_LARGE", "File too large");
			}
		});
		const { fs, backend, pushed, workspacePath } = built;
		const live = fs as FileSystem & { files: Map<string, string> };

		const run1 = await sync(backend, live, workspacePath);
		expect(run1.failedFiles.map((f) => f.path)).toEqual(["big.md"]);

		// User trims the note; the gate opens: next run pushes it and the
		// stale rejection is cleared from state.
		live.files.set("big.md", "small now");
		gate.reject = false;
		const run2 = await sync(backend, live, workspacePath);
		expect(run2.failedFiles).toEqual([]);
		expect(pushed).toContain("big.md");
		const state2 = await readState(live, workspacePath);
		expect(state2.rejectedFiles?.["big.md"]).toBeUndefined();
		expect(state2.files["big.md"]?.hash).toBe(await contentHash("small now"));
	});
});

describe("listing failures never lose progress (P0-2 client)", () => {
	it("a pull-listing failure after pushes still records progress; the next run resumes without re-pushing", async () => {
		const gate = { failListings: true };
		const seed: Record<string, string> = {
			"a.md": "aaa",
			"b.md": "bbb",
			"c.md": "ccc",
		};
		const built = harness(seed, () => {});
		const getFilesCalls: string[] = [];
		const remote = new Map<string, { contentHash: string; content: string }>();
		const pushed: string[] = [];
		const backend: SyncBackend = {
			async getWorkspace() {
				return "ws-1";
			},
			async createWorkspace() {
				return "ws-1";
			},
			async getFiles() {
				getFilesCalls.push("call");
				if (gate.failListings && getFilesCalls.length === 2) {
					// execute()'s listing: plan()'s already succeeded and the
					// pushes below have gone through.
					throw httpError(500, "UNKNOWN", "Internal error.");
				}
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
				pushed.push(args.path);
				remote.set(args.path, {
					contentHash: args.contentHash,
					content: args.content,
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
		};
		const { fs, workspacePath } = built;

		// Run 1 throws at the pull listing — but the three pushes happened
		// first and must already be recorded.
		await expect(sync(backend, fs, workspacePath)).rejects.toThrow(
			"Internal error.",
		);
		expect(pushed.sort()).toEqual(["a.md", "b.md", "c.md"]);
		const state1 = await readState(fs, workspacePath);
		expect(Object.keys(state1.files).sort()).toEqual(["a.md", "b.md", "c.md"]);
		expect(state1.lastSyncedAt).toBeGreaterThan(1);

		// Run 2 completes without re-pushing anything.
		gate.failListings = false;
		const run2 = await sync(backend, fs, workspacePath);
		expect(pushed).toHaveLength(3);
		expect(run2.failedFiles).toEqual([]);
		const state2 = await readState(fs, workspacePath);
		expect(state2.lastSyncedAt).toBeGreaterThanOrEqual(state1.lastSyncedAt);
	});

	it("rejected entries for locally-deleted files are pruned from state", async () => {
		const built = harness({ "ok.md": "fine" }, () => {});
		const { fs, backend, workspacePath } = built;
		await fs.writeFile(
			`${workspacePath}/.hubble/state.json`,
			JSON.stringify({
				lastSyncedAt: 1,
				files: {},
				rejectedFiles: {
					"gone.md": { hash: "h", message: "m", rejectedAt: 1 },
				},
			}),
		);

		const result = await sync(backend, fs, workspacePath);
		expect(result.failedFiles).toEqual([]);
		const state = await readState(fs, workspacePath);
		expect(state.rejectedFiles ?? {}).toEqual({});
	});
});

describe("M5 plan semantics (totalOps is work to do)", () => {
	it("withheld pushes ride on skippedPushes and never inflate totalOps", async () => {
		const big = "x".repeat(100);
		const built = harness({ "ok.md": "fine", "big.md": big }, () => {});
		const { fs, backend, workspacePath } = built;
		await fs.writeFile(
			`${workspacePath}/.hubble/state.json`,
			JSON.stringify({
				lastSyncedAt: 1,
				files: {},
				rejectedFiles: {
					"big.md": {
						hash: await contentHash(big),
						code: "FILE_TOO_LARGE",
						message: "File too large",
						rejectedAt: 1,
					},
				},
			}),
		);

		const computed = await plan(backend, fs, workspacePath);
		expect(computed.toPush.map((p) => p.path)).toEqual(["ok.md"]);
		expect(computed.skippedPushes?.map((s) => s.path)).toEqual(["big.md"]);
		// Only real work counts: a desktop progress bar driven by totalOps
		// reports done for this workspace instead of hanging on "push".
		expect(computed.totalOps).toBe(1);
	});
});
