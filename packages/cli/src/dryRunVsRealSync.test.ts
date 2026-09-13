import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SyncBackend } from "@hubble.md/sync";
import { sync, writeCloudSyncConfig, writeSyncState } from "@hubble.md/sync";
import { createNodeFileSystem } from "@hubble.md/sync/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeDryRunReport } from "./dryRun.js";

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

// QA7a (R17) — enabling sync immediately after the dry-run (no intervening
// edits) uploads exactly the file set the dry-run reported.
//
// LIMITATION (honest, see delivery report): the Stage 3/4 Cloudflare client
// doesn't exist yet, so "enabling sync" here means the real `sync()` engine
// from packages/sync against an in-memory recording SyncBackend — not the
// real Cloudflare Worker. What this proves is that the same walker-backed
// FileSystem feeds both the dry-run and the real sync loop, so they can't
// structurally diverge. It does not prove the network leg end to end.
describe("dry-run vs. real sync (R17, partially proven — see limitation above)", () => {
	beforeEach(async () => {
		workspaceRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "dry-run-vs-sync-"),
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
		vi.unstubAllGlobals();
	});

	it("uploads exactly the file set the dry-run reported, no more and no fewer", async () => {
		await writeFixture("note.md", "hello");
		await writeFixture(".exposed/dot-folder-note.md", "newly synced");
		await writeFixture(".gitignore", "ignored.md\n");
		await writeFixture("ignored.md", "should never sync");
		await writeFixture("photo.assets/image.png", "fake-png-bytes");

		const dryRun = await computeDryRunReport(workspaceRoot);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				json: async () => ({ storageId: "fake-storage-id" }),
			})),
		);
		const { backend, pushedFilePaths, pushedAssetPaths } =
			createRecordingBackend();
		await sync(backend, createNodeFileSystem(), workspaceRoot);

		const actuallySynced = [...pushedFilePaths, ...pushedAssetPaths].sort();
		expect(actuallySynced).toEqual(dryRun.wouldSync);
	});
});
