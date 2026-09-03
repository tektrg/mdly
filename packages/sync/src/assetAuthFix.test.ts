import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncBackend } from "./backend.js";
import { writeCloudSyncConfig, writeSyncState } from "./config.js";
import { createNodeFileSystem } from "./fs-node.js";
import { sync } from "./sync.js";
import type { RemoteAsset } from "./types.js";

// The "bare unauthenticated fetch" defect this package's Cloudflare backend
// fixes: `generateAssetUploadUrl`/`getAssetDownloadUrl` hand back an
// `AuthorizedUrl` (`{url, headers}`), and it is `sync.ts`'s own `pushAsset`/
// `pullAsset` helpers — not the backend — that must actually spread those
// headers onto the raw follow-up `fetch()` call to R2. `backend.test.ts` in
// `@mdly/cloudflare-client` proves the backend returns the right shape and
// that a manually-built `fetch()` with those headers succeeds against the
// real Worker; it never exercises `sync.ts` itself. This file closes that
// gap directly: a mock backend returns bearer-style headers, and the test
// asserts the actual `fetch()` calls `sync()` makes carry them.

const AUTH_HEADER = { Authorization: "Bearer test-token" };

let workspaceRoot: string;

async function writeBinaryFixture(relativePath: string, bytes: number[]) {
	const absolutePath = path.join(workspaceRoot, relativePath);
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.writeFile(absolutePath, Uint8Array.from(bytes));
}

function createAuthedAssetBackend(opts: {
	remoteAssets?: RemoteAsset[];
}): SyncBackend {
	return {
		async getWorkspace() {
			return null;
		},
		async createWorkspace() {
			return "test-workspace";
		},
		async getFiles() {
			return [];
		},
		async pushFile() {},
		async softDeleteFile() {},
		async getAssets() {
			return opts.remoteAssets ?? [];
		},
		async pushAsset() {},
		async softDeleteAsset() {},
		async generateAssetUploadUrl() {
			return {
				url: "https://example.invalid/api/asset/upload",
				headers: { ...AUTH_HEADER },
			};
		},
		async getAssetDownloadUrl(storageId) {
			return {
				url: `https://example.invalid/api/asset/${storageId}`,
				headers: { ...AUTH_HEADER },
			};
		},
	};
}

describe("sync()'s pushAsset/pullAsset forward AuthorizedUrl headers to the raw fetch (asset-auth-fix)", () => {
	let originalFetch: typeof fetch;

	beforeEach(async () => {
		workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "asset-auth-fix-"));
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
		originalFetch = globalThis.fetch;
	});

	afterEach(async () => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
		await fs.rm(workspaceRoot, { recursive: true, force: true });
	});

	it("pushAsset: uploads a new local asset with the backend-provided Authorization header attached", async () => {
		await writeBinaryFixture("note.assets/pic.png", [137, 80, 78, 71]);

		const calls: Array<{ url: string; init?: RequestInit }> = [];
		globalThis.fetch = vi.fn(
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				calls.push({ url: String(input), init });
				return new Response(JSON.stringify({ storageId: "hash-abc" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
		) as typeof fetch;

		const backend = createAuthedAssetBackend({ remoteAssets: [] });
		const result = await sync(backend, createNodeFileSystem(), workspaceRoot);

		expect(result.assetsPushed).toBe(1);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("https://example.invalid/api/asset/upload");
		const sentHeaders = new Headers(calls[0]!.init?.headers);
		expect(sentHeaders.get("Authorization")).toBe("Bearer test-token");
	});

	it("pullAsset: downloads a new remote asset with the backend-provided Authorization header attached", async () => {
		const remoteAsset: RemoteAsset = {
			_id: "r1",
			path: "note.assets/pic.png",
			storageId: "hash-xyz",
			contentHash: "hash-xyz",
			updatedAt: 1,
			deviceId: "device-other",
			deleted: false,
		};

		const calls: Array<{ url: string; init?: RequestInit }> = [];
		globalThis.fetch = vi.fn(
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				calls.push({ url: String(input), init });
				return new Response(Uint8Array.from([1, 2, 3, 4]), { status: 200 });
			},
		) as typeof fetch;

		const backend = createAuthedAssetBackend({ remoteAssets: [remoteAsset] });
		const result = await sync(backend, createNodeFileSystem(), workspaceRoot);

		expect(result.assetsPulled).toBe(1);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("https://example.invalid/api/asset/hash-xyz");
		const sentHeaders = new Headers(calls[0]!.init?.headers);
		expect(sentHeaders.get("Authorization")).toBe("Bearer test-token");

		const downloaded = await fs.readFile(
			path.join(workspaceRoot, "note.assets/pic.png"),
		);
		expect([...downloaded]).toEqual([1, 2, 3, 4]);
	});
});
