import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SyncBackend } from "./backend.js";
import { writeCloudSyncConfig, writeSyncState } from "./config.js";
import { contentHash, type FileSystem, type LocalFile } from "./fs.js";
import { createNodeFileSystem } from "./fs-node.js";
import { mergeJsonlUnion } from "./sidecarMerge.js";
import { plan, planSidecars } from "./sync.js";
import type { RemoteFile } from "./types.js";

const CANON = ".mdly/comments/note.jsonl";
const SLOTTED = ".mdly/comments/note 2.jsonl";
const INDEX = ".mdly/history/index.jsonl";

async function localFile(
	relativePath: string,
	content: string,
): Promise<LocalFile> {
	return {
		relativePath,
		content,
		hash: await contentHash(content),
	};
}

/** Minimal FileSystem stub carrying only the sidecar list under test. */
async function stubFs(files: LocalFile[]): Promise<FileSystem> {
	return {
		async listSidecarFiles() {
			return files;
		},
	} as unknown as FileSystem;
}

function remoteRow(
	relativePath: string,
	content: string,
	opts?: { hash?: string; deleted?: boolean },
): RemoteFile {
	return {
		_id: `remote-${relativePath}`,
		path: relativePath,
		contentHash: opts?.hash ?? `hash-of-${content}`,
		content,
		updatedAt: Date.now(),
		deviceId: "phone-1",
		deleted: opts?.deleted ?? false,
	};
}

const ev = (id: string) => JSON.stringify({ id });

describe("planSidecars classification table", () => {
	it("local-only canonical log plans a push", async () => {
		const local = await localFile(CANON, `${ev("a")}\n`);
		const ops = await planSidecars(await stubFs([local]), "/ws", [], {});
		expect(ops.toPush.map((o) => o.path)).toEqual([CANON]);
		expect(ops.toPull).toEqual([]);
		expect(ops.merged).toEqual([]);
	});

	it("local-only slotted sibling is refused: desktop never pushes it", async () => {
		const local = await localFile(SLOTTED, `${ev("a")}\n`);
		const ops = await planSidecars(await stubFs([local]), "/ws", [], {});
		expect(ops.toPush).toEqual([]);
		expect(ops.toPull).toEqual([]);
		expect(ops.merged).toEqual([]);
	});

	it("local-only history index shard plans a push", async () => {
		const local = await localFile(INDEX, '{"path":"note.md"}\n');
		const ops = await planSidecars(await stubFs([local]), "/ws", [], {});
		expect(ops.toPush.map((o) => o.path)).toEqual([INDEX]);
	});

	it("remote-only live log plans a pull", async () => {
		const ops = await planSidecars(
			await stubFs([]),
			"/ws",
			[remoteRow(CANON, `${ev("a")}\n`)],
			{},
		);
		expect(ops.toPull.map((o) => o.path)).toEqual([CANON]);
		expect(ops.toPush).toEqual([]);
		expect(ops.merged).toEqual([]);
	});

	it("baseline-known but locally missing with live remote pulls (wipe/clone restore)", async () => {
		const remote = remoteRow(CANON, `${ev("a")}\n`, { hash: "h-remote" });
		const ops = await planSidecars(await stubFs([]), "/ws", [remote], {
			[CANON]: { hash: "h-old", lastSyncedAt: 1 },
		});
		expect(ops.toPull.map((o) => o.path)).toEqual([CANON]);
	});

	it("in-sync both sides plans nothing", async () => {
		const content = `${ev("a")}\n`;
		const local = await localFile(CANON, content);
		const ops = await planSidecars(
			await stubFs([local]),
			"/ws",
			[remoteRow(CANON, content, { hash: local.hash })],
			{ [CANON]: { hash: local.hash, lastSyncedAt: 1 } },
		);
		expect(ops).toEqual({ toPush: [], toPull: [], merged: [] });
	});

	it("diverged with local unchanged plans a pull", async () => {
		const localContent = `${ev("a")}\n`;
		const remoteContent = `${ev("a")}\n${ev("b")}\n`;
		const local = await localFile(CANON, localContent);
		const ops = await planSidecars(
			await stubFs([local]),
			"/ws",
			[remoteRow(CANON, remoteContent, { hash: "h-remote" })],
			{ [CANON]: { hash: local.hash, lastSyncedAt: 1 } },
		);
		expect(ops.toPull.map((o) => o.path)).toEqual([CANON]);
		expect(ops.toPull[0]?.content).toBe(remoteContent);
		expect(ops.merged).toEqual([]);
	});

	it("diverged with local also changed plans a merge, never a conflict", async () => {
		const localContent = `${ev("a")}\n${ev("b")}\n`;
		const remoteContent = `${ev("a")}\n${ev("c")}\n`;
		const local = await localFile(CANON, localContent);
		const ops = await planSidecars(
			await stubFs([local]),
			"/ws",
			[remoteRow(CANON, remoteContent, { hash: "h-remote" })],
			{ [CANON]: { hash: "h-base", lastSyncedAt: 1 } },
		);
		expect(ops.merged.map((o) => o.path)).toEqual([CANON]);
		expect(ops.merged[0]?.content).toBe(
			mergeJsonlUnion(localContent, remoteContent),
		);
		expect(ops.merged[0]?.hash).toBe(
			await contentHash(mergeJsonlUnion(localContent, remoteContent)),
		);
		expect(ops.toPush).toEqual([]);
		expect(ops.toPull).toEqual([]);
	});

	it("diverged slotted sibling with local edits pulls: merged could never be pushed", async () => {
		const local = await localFile(SLOTTED, `${ev("a")}\n${ev("b")}\n`);
		const ops = await planSidecars(
			await stubFs([local]),
			"/ws",
			[remoteRow(SLOTTED, `${ev("a")}\n${ev("c")}\n`, { hash: "h-r" })],
			{ [SLOTTED]: { hash: "h-base", lastSyncedAt: 1 } },
		);
		expect(ops.merged).toEqual([]);
		expect(ops.toPush).toEqual([]);
		expect(ops.toPull.map((o) => o.path)).toEqual([SLOTTED]);
	});

	it("remote tombstone with a live local file is IGNORED: no delete, no pull, no push", async () => {
		const local = await localFile(CANON, `${ev("a")}\n`);
		const ops = await planSidecars(
			await stubFs([local]),
			"/ws",
			[remoteRow(CANON, "", { deleted: true })],
			{ [CANON]: { hash: local.hash, lastSyncedAt: 1 } },
		);
		expect(ops).toEqual({ toPush: [], toPull: [], merged: [] });
	});

	it("remote tombstone with no local file is IGNORED", async () => {
		const ops = await planSidecars(
			await stubFs([]),
			"/ws",
			[remoteRow(CANON, "", { deleted: true })],
			{ [CANON]: { hash: "h-old", lastSyncedAt: 1 } },
		);
		expect(ops).toEqual({ toPush: [], toPull: [], merged: [] });
	});

	it("non-allowlisted .mdly rows (revision blobs) stay ignored", async () => {
		const blob = ".mdly/history/objects/ab";
		const local = await localFile(blob, "blob-bytes");
		const ops = await planSidecars(
			await stubFs([local]),
			"/ws",
			[remoteRow(blob, "blob-bytes")],
			{},
		);
		expect(ops).toEqual({ toPush: [], toPull: [], merged: [] });
	});
});

describe("plan() wires sidecars without un-fencing notes", () => {
	let workspaceRoot: string;

	beforeEach(async () => {
		workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sidecar-plan-"));
		const fileSystem = createNodeFileSystem();
		await writeCloudSyncConfig(fileSystem, workspaceRoot, {
			provider: "cloudflare",
			deploymentUrl: "http://127.0.0.1:3210",
			workspaceId: "test-workspace",
			deviceId: "device-1",
			backgroundSync: false,
		});
		await writeSyncState(fileSystem, workspaceRoot, {
			lastSyncedAt: 0,
			files: {},
		});
	});

	afterEach(async () => {
		await fs.rm(workspaceRoot, { recursive: true, force: true });
	});

	async function writeFixture(relativePath: string, content = "") {
		const absolutePath = path.join(workspaceRoot, relativePath);
		await fs.mkdir(path.dirname(absolutePath), { recursive: true });
		await fs.writeFile(absolutePath, content);
	}

	function backendWith(remoteFiles: RemoteFile[]): SyncBackend {
		return {
			async getWorkspace() {
				return null;
			},
			async createWorkspace() {
				return "test-workspace";
			},
			async getFiles() {
				return remoteFiles;
			},
			async pushFile() {},
			async softDeleteFile() {},
			async getAssets() {
				return [];
			},
			async pushAsset() {},
			async softDeleteAsset() {},
			async generateAssetUploadUrl() {
				return { url: "https://example.invalid/upload" };
			},
			async getAssetDownloadUrl() {
				return null;
			},
		};
	}

	it("reports sidecar intent apart from notes, includes it in totalOps, never in conflicts", async () => {
		await writeFixture("note.md", "hello");
		await writeFixture(CANON, `${ev("a")}\n`);
		const backend = backendWith([
			remoteRow(CANON, `${ev("a")}\n${ev("b")}\n`, { hash: "h-remote" }),
		]);
		const computed = await plan(
			backend,
			createNodeFileSystem(),
			workspaceRoot,
		);
		// No baseline: local sidecar counts as changed → merged, not conflict.
		expect(computed.sidecarOps?.merged.map((o) => o.path)).toEqual([CANON]);
		expect(computed.conflicts).toEqual([]);
		for (const list of [
			computed.toPush,
			computed.toPull,
			computed.toDelete,
			computed.conflicts,
		]) {
			expect(list.some((entry) => {
				const p = typeof entry === "string" ? entry : entry.path;
				return p.startsWith(".mdly/");
			})).toBe(false);
		}
		// totalOps counts sidecar work now that execute() performs it (Round 4).
		expect(computed.totalOps).toBe(
			computed.toPush.length +
				computed.toPull.length +
				computed.toDelete.length +
				computed.conflicts.length +
				computed.assetOps.toPush.length +
				computed.assetOps.toPull.length +
				computed.assetOps.toDelete.length +
				(computed.sidecarOps?.toPush.length ?? 0) +
				(computed.sidecarOps?.toPull.length ?? 0) +
				(computed.sidecarOps?.merged.length ?? 0),
		);
	});
});


