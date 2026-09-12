import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SyncBackend } from "./backend.js";
import { readSyncState, writeCloudSyncConfig, writeSyncState } from "./config.js";
import { contentHash } from "./fs.js";
import { createNodeFileSystem } from "./fs-node.js";
import { mergeJsonlUnion } from "./sidecarMerge.js";
import { execute, sync } from "./sync.js";
import type { RemoteFile, SyncPlan } from "./types.js";

const CANON = ".mdly/comments/note.jsonl";
const SLOTTED = ".mdly/comments/note 2.jsonl";

const ev = (id: string) => JSON.stringify({ id });

function emptyPlan(): SyncPlan {
	return {
		toPush: [],
		toPull: [],
		toDelete: [],
		conflicts: [],
		unchanged: 0,
		assetOps: { toPush: [], toPull: [], toDelete: [] },
		folders: [],
		totalOps: 0,
		sidecarOps: { toPush: [], toPull: [], merged: [] },
	};
}

function remoteRow(relativePath: string, content: string): RemoteFile {
	return {
		_id: `remote-${relativePath}`,
		path: relativePath,
		contentHash: `hash-of-${content}`,
		content,
		updatedAt: Date.now(),
		deviceId: "phone-1",
		deleted: false,
	};
}

type PushArgs = {
	path: string;
	contentHash: string;
	content: string;
	deviceId: string;
};

/** Recording backend with swappable file list and push behaviour. */
function recordingBackend(opts: {
	files: () => RemoteFile[];
	onPush?: (args: PushArgs) => void | Promise<void>;
}) {
	const pushed: PushArgs[] = [];
	const backend: SyncBackend = {
		async getWorkspace() {
			return null;
		},
		async createWorkspace() {
			return "test-workspace";
		},
		async getFiles() {
			return opts.files();
		},
		async pushFile(args) {
			await opts.onPush?.(args);
			pushed.push(args);
		},
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
	return { backend, pushed };
}

describe("executeSidecars (Round 4)", () => {
	let workspaceRoot: string;

	beforeEach(async () => {
		workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sidecar-exec-"));
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

	it("toPush pushes via backend.pushFile and records the baseline", async () => {
		const content = `${ev("a")}\n`;
		const { backend, pushed } = recordingBackend({ files: () => [] });
		const computed = emptyPlan();
		computed.sidecarOps?.toPush.push({
			path: CANON,
			hash: await contentHash(content),
			content,
		});
		const result = await execute(
			computed,
			backend,
			createNodeFileSystem(),
			workspaceRoot,
		);
		expect(pushed).toEqual([
			{
				workspaceId: "test-workspace",
				path: CANON,
				contentHash: await contentHash(content),
				content,
				deviceId: "device-1",
			},
		]);
		expect(result.sidecarsPushed).toBe(1);
		// The fence holds in results: note arrays never carry `.mdly` paths.
		expect(result.pushed).toEqual([]);
		const state = await readSyncState(createNodeFileSystem(), workspaceRoot);
		expect(state.sidecars?.[CANON]?.hash).toBe(await contentHash(content));
	});

	it("toPull writes via fs.writeFile, creating parents, and records the baseline", async () => {
		const content = `${ev("b")}\n`;
		const { backend } = recordingBackend({ files: () => [] });
		const computed = emptyPlan();
		computed.sidecarOps?.toPull.push({
			path: SLOTTED,
			hash: "h-remote",
			content,
		});
		const result = await execute(
			computed,
			backend,
			createNodeFileSystem(),
			workspaceRoot,
		);
		await expect(
			fs.readFile(path.join(workspaceRoot, SLOTTED), "utf-8"),
		).resolves.toBe(content);
		expect(result.sidecarsPulled).toBe(1);
		expect(result.pulled).toEqual([]);
		const state = await readSyncState(createNodeFileSystem(), workspaceRoot);
		expect(state.sidecars?.[SLOTTED]?.hash).toBe("h-remote");
	});

	it("toPull prefers fresh execute-time remote content over the planned copy", async () => {
		const planned = `${ev("b")}\n`;
		const fresh = `${ev("b")}\n${ev("c")}\n`;
		const freshRow = {
			...remoteRow(SLOTTED, fresh),
			contentHash: "h-fresh",
		};
		const { backend } = recordingBackend({ files: () => [freshRow] });
		const computed = emptyPlan();
		computed.sidecarOps?.toPull.push({
			path: SLOTTED,
			hash: "h-planned",
			content: planned,
		});
		await execute(computed, backend, createNodeFileSystem(), workspaceRoot);
		await expect(
			fs.readFile(path.join(workspaceRoot, SLOTTED), "utf-8"),
		).resolves.toBe(fresh);
		const state = await readSyncState(createNodeFileSystem(), workspaceRoot);
		expect(state.sidecars?.[SLOTTED]?.hash).toBe("h-fresh");
	});

	it("a failing sidecar push neither aborts the run nor touches other ops, and surfaces with kind sidecar", async () => {
		const okContent = `${ev("ok")}\n`;
		const { backend, pushed } = recordingBackend({
			files: () => [],
			onPush: (args) => {
				if (args.path === ".mdly/comments/fail-transient.jsonl") {
					throw { status: 403, message: "slot invariant" };
				}
				if (args.path === ".mdly/comments/fail-permanent.jsonl") {
					throw { status: 413, message: "too big" };
				}
			},
		});
		const computed = emptyPlan();
		computed.toPush.push({
			path: "note.md",
			hash: "h-note",
			content: "hello",
		});
		computed.sidecarOps?.toPush.push(
			{
				path: ".mdly/comments/fail-transient.jsonl",
				hash: "h-t",
				content: `${ev("t")}\n`,
			},
			{
				path: ".mdly/comments/fail-permanent.jsonl",
				hash: "h-p",
				content: `${ev("p")}\n`,
			},
			{ path: CANON, hash: await contentHash(okContent), content: okContent },
		);
		const result = await execute(
			computed,
			backend,
			createNodeFileSystem(),
			workspaceRoot,
		);
		// The note and the good sidecar still went through.
		expect(result.pushed).toEqual(["note.md"]);
		expect(pushed.map((p) => p.path)).toEqual(["note.md", CANON]);
		expect(result.sidecarsPushed).toBe(1);
		// Both failures surface, distinctly marked as sidecars.
		expect(
			result.failedFiles.filter((f) => f.kind === "sidecar"),
		).toEqual([
			{
				path: ".mdly/comments/fail-transient.jsonl",
				permanent: false,
				kind: "sidecar",
				message: "slot invariant",
			},
			{
				path: ".mdly/comments/fail-permanent.jsonl",
				permanent: true,
				kind: "sidecar",
				message: "too big",
			},
		]);
		// Failed pushes record no baseline, so they retry next run.
		const state = await readSyncState(createNodeFileSystem(), workspaceRoot);
		expect(state.sidecars?.[".mdly/comments/fail-transient.jsonl"]).toBeUndefined();
		expect(state.sidecars?.[".mdly/comments/fail-permanent.jsonl"]).toBeUndefined();
		expect(state.sidecars?.[CANON]?.hash).toBe(await contentHash(okContent));
	});

	it("merged writes the union locally AND pushes it", async () => {
		const localContent = `${ev("a")}\n`;
		const canonAbs = path.join(workspaceRoot, CANON);
		await fs.mkdir(path.dirname(canonAbs), { recursive: true });
		await fs.writeFile(canonAbs, localContent);
		const union = mergeJsonlUnion(localContent, `${ev("b")}\n`);
		const { backend, pushed } = recordingBackend({ files: () => [] });
		const computed = emptyPlan();
		computed.sidecarOps?.merged.push({
			path: CANON,
			hash: await contentHash(union),
			content: union,
		});
		const result = await execute(
			computed,
			backend,
			createNodeFileSystem(),
			workspaceRoot,
		);
		await expect(fs.readFile(canonAbs, "utf-8")).resolves.toBe(union);
		expect(pushed.map((p) => p.path)).toEqual([CANON]);
		expect(pushed[0]?.content).toBe(union);
		expect(result.sidecarsMerged).toBe(1);
		const state = await readSyncState(createNodeFileSystem(), workspaceRoot);
		expect(state.sidecars?.[CANON]?.hash).toBe(await contentHash(union));
	});

	it("merged with a failed push keeps the local write but records no baseline and reports", async () => {
		const union = mergeJsonlUnion(`${ev("a")}\n`, `${ev("b")}\n`);
		const { backend } = recordingBackend({
			files: () => [],
			onPush: () => {
				throw { status: 500, message: "boom" };
			},
		});
		const computed = emptyPlan();
		computed.sidecarOps?.merged.push({
			path: CANON,
			hash: await contentHash(union),
			content: union,
		});
		const result = await execute(
			computed,
			backend,
			createNodeFileSystem(),
			workspaceRoot,
		);
		await expect(
			fs.readFile(path.join(workspaceRoot, CANON), "utf-8"),
		).resolves.toBe(union);
		expect(result.sidecarsMerged).toBe(0);
		expect(result.failedFiles).toEqual([
			{ path: CANON, permanent: false, kind: "sidecar", message: "boom" },
		]);
		const state = await readSyncState(createNodeFileSystem(), workspaceRoot);
		expect(state.sidecars?.[CANON]).toBeUndefined();
	});

	it("state.sidecars persists across two sync() runs and seeds the second baseline", async () => {
		const canonAbs = path.join(workspaceRoot, CANON);
		await fs.mkdir(path.dirname(canonAbs), { recursive: true });
		await fs.writeFile(canonAbs, `${ev("a")}\n`);
		let remoteFiles: RemoteFile[] = [];
		const { backend } = recordingBackend({ files: () => remoteFiles });
		const fileSystem = createNodeFileSystem();

		// Run 1: local-only log pushes; the baseline is recorded.
		const run1 = await sync(backend, fileSystem, workspaceRoot);
		expect(run1.sidecarsPushed).toBe(1);
		const afterRun1 = await readSyncState(fileSystem, workspaceRoot);
		const hashA = await contentHash(`${ev("a")}\n`);
		expect(afterRun1.sidecars?.[CANON]?.hash).toBe(hashA);

		// Run 2: remote added an event, local unchanged vs baseline → pull,
		// not merge. (Without the persisted baseline this would plan merged.)
		const remoteContent = `${ev("a")}\n${ev("b")}\n`;
		remoteFiles = [{ ...remoteRow(CANON, remoteContent), contentHash: "h-ab" }];
		const run2 = await sync(backend, fileSystem, workspaceRoot);
		expect(run2.sidecarsPulled).toBe(1);
		expect(run2.sidecarsMerged).toBe(0);
		await expect(fs.readFile(canonAbs, "utf-8")).resolves.toBe(remoteContent);
		const afterRun2 = await readSyncState(fileSystem, workspaceRoot);
		expect(afterRun2.sidecars?.[CANON]?.hash).toBe("h-ab");
	});
});
