import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SyncBackend } from "./backend.js";
import { writeCloudSyncConfig, writeSyncState } from "./config.js";
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

	it("pushes the note but never the sidecar JSONL sitting right next to it", async () => {
		await writeFixture("note.md", "hello");
		await writeFixture(".mdly/comments/note.jsonl", '{"id":"c1"}\n');

		const { backend, pushedFilePaths, pushedAssetPaths } =
			createRecordingBackend();
		await sync(backend, createNodeFileSystem(), workspaceRoot);

		expect(pushedFilePaths).toEqual(["note.md"]);
		expect(pushedAssetPaths).toEqual([]);
		expect(pushedFilePaths.some((p) => p.startsWith(".mdly/"))).toBe(false);
	});
});
