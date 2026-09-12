import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SyncBackend } from "./backend.js";
import { writeCloudSyncConfig, writeSyncState } from "./config.js";
import { contentHash } from "./fs.js";
import { createNodeFileSystem } from "./fs-node.js";
import { sync } from "./sync.js";

let workspaceRoot: string;

async function writeFixture(relativePath: string, content = "") {
	const absolutePath = path.join(workspaceRoot, relativePath);
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.writeFile(absolutePath, content);
}

function createRecordingBackend() {
	const pushedFilePaths: string[] = [];
	const pushedAssetPaths: string[] = [];
	const backend: SyncBackend = {
		async getWorkspace() {
			return null;
		},
		async createWorkspace() {
			return "test-workspace";
		},
		async getFiles() {
			return [];
		},
		async pushFile(args) {
			pushedFilePaths.push(args.path);
		},
		async softDeleteFile() {},
		async getAssets() {
			return [];
		},
		async pushAsset(args) {
			pushedAssetPaths.push(args.path);
		},
		async softDeleteAsset() {},
		async generateAssetUploadUrl() {
			return { url: "https://example.invalid/upload" };
		},
		async getAssetDownloadUrl() {
			return null;
		},
	};
	return { backend, pushedFilePaths, pushedAssetPaths };
}

// QA5b / R18 (D9) — in Phase 1 the sidecar walker feeds ONLY the dry-run
// report. This proves the real sync loop — which is what packages/sync
// actually runs today — never pushes a `.mdly/**/*.jsonl` path, because its
// FileSystem interface only ever asks the notes/assets walkers for files.
// Live sidecar sync is Phase 2 (out of this delivery's scope).
describe("Phase 1 sync loop never touches .mdly sidecars (D9/R18)", () => {
	beforeEach(async () => {
		workspaceRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "phase1-sidecar-scope-"),
		);
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

	it("pushes the note and the allowlisted sidecar, but never a revision blob", async () => {
		await writeFixture("note.md", "hello");
		await writeFixture(".mdly/comments/note.jsonl", '{"id":"c1"}\n');
		await writeFixture(".mdly/history/objects/ab", "blob-bytes");

		const { backend, pushedFilePaths, pushedAssetPaths } =
			createRecordingBackend();
		const result = await sync(backend, createNodeFileSystem(), workspaceRoot);

		expect(pushedFilePaths).toEqual(["note.md", ".mdly/comments/note.jsonl"]);
		expect(pushedAssetPaths).toEqual([]);
		expect(pushedFilePaths.some((p) => p.includes("objects/"))).toBe(false);
		// Notes and sidecars report apart: the note array never carries `.mdly`.
		expect(result.pushed).toEqual(["note.md"]);
		expect(result.sidecarsPushed).toBe(1);
	});

	// tombstone-then-403-fence (Step 1) — the trap from the plan: a remote
	// `.mdly/comments/x 2.jsonl` row used to read as locally deleted forever
	// (both walkers prune `.mdly`), so execute() fired
	// backend.softDeleteFile, the worker slot invariant 403d, and desktop
	// sync died permanently. Rounds 3–4 changed the answer from "zero ops"
	// to "pull": the log lands on disk and baselines, and the second run is
	// quiet. What never comes back is the tombstone op — no softDeleteFile
	// for a sidecar on either run, asserting on recorded backend calls.
	it("a remote-only .mdly/comments/x 2.jsonl pulls once, then idles, with no softDeleteFile on either run", async () => {
		const pushedFilePaths: string[] = [];
		const softDeletedPaths: string[] = [];
		const sidecarContent = '{"id":"c2"}\n';
		const backend: SyncBackend = {
			async getWorkspace() {
				return null;
			},
			async createWorkspace() {
				return "test-workspace";
			},
			async getFiles() {
				return [
					{
						_id: "sidecar-1",
						path: ".mdly/comments/note 2.jsonl",
						// Real content hash: the second run must read the
						// pulled log as in-sync, not diverged.
						contentHash: await contentHash(sidecarContent),
						content: sidecarContent,
						updatedAt: Date.now(),
						deviceId: "phone-1",
						deleted: false,
					},
				];
			},
			async pushFile(args) {
				pushedFilePaths.push(args.path);
			},
			async softDeleteFile(args) {
				softDeletedPaths.push(args.path);
			},
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

		const fileSystem = createNodeFileSystem();
		const first = await sync(backend, fileSystem, workspaceRoot);
		const second = await sync(backend, fileSystem, workspaceRoot);

		// First run pulls the log through the sidecar path, not the note one.
		expect(first.sidecarsPulled).toBe(1);
		expect(first.pulled).toEqual([]);
		// Second run is fully quiet: the baseline recorded by the first run
		// makes the log read as in-sync, not as locally-deleted.
		for (const result of [second]) {
			expect(result.pushed).toEqual([]);
			expect(result.pulled).toEqual([]);
			expect(result.deleted).toEqual([]);
			expect(result.conflicts).toEqual([]);
			expect(result.sidecarsPushed).toBe(0);
			expect(result.sidecarsPulled).toBe(0);
			expect(result.sidecarsMerged).toBe(0);
		}
		expect(first.pushed).toEqual([]);
		expect(first.deleted).toEqual([]);
		expect(first.conflicts).toEqual([]);
		expect(pushedFilePaths).toEqual([]);
		expect(softDeletedPaths).toEqual([]);
		// The log landed on disk with the remote content.
		await expect(
			fs.readFile(
				path.join(workspaceRoot, ".mdly/comments/note 2.jsonl"),
				"utf-8",
			),
		).resolves.toBe('{"id":"c2"}\n');
	});
});
