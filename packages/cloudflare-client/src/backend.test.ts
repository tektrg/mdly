import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCloudflareBackend } from "./backend.js";
import type { RealWorkerHandle } from "./testHarness/realWorker.js";
import { startRealWorker, TEST_PASSWORD } from "./testHarness/realWorker.js";

/**
 * All 10 SyncBackend methods (R1, R9), exercised against the REAL Stage 1
 * Worker + Durable Object + R2 via a real (in-memory) Miniflare instance —
 * not a hand-rolled mock of the Worker's HTTP surface.
 */
describe("createCloudflareBackend — all 10 SyncBackend methods (R1, R9)", () => {
	let worker: RealWorkerHandle;

	beforeAll(async () => {
		worker = await startRealWorker();
	}, 30000);

	afterAll(async () => {
		await worker.dispose();
	});

	function bearerBackend() {
		return createCloudflareBackend({
			baseUrl: worker.baseUrl,
			auth: { kind: "bearer", token: TEST_PASSWORD },
		});
	}

	it("getWorkspace returns null for an unknown name, then the name itself once created", async () => {
		const backend = bearerBackend();
		expect(await backend.getWorkspace("backend-unknown-ws")).toBeNull();
		const id = await backend.createWorkspace("backend-unknown-ws");
		expect(id).toBe("backend-unknown-ws");
		expect(await backend.getWorkspace("backend-unknown-ws")).toBe(
			"backend-unknown-ws",
		);
	});

	it("pushFile / getFiles round-trip content + hash, includeDeleted and since both work", async () => {
		const backend = bearerBackend();
		const workspaceId = await backend.createWorkspace("backend-files-ws");

		await backend.pushFile({
			workspaceId,
			path: "note.md",
			contentHash: "hash-1",
			content: "hello world",
			deviceId: "device-a",
		});
		const files = await backend.getFiles(workspaceId);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatchObject({
			path: "note.md",
			contentHash: "hash-1",
			content: "hello world",
			deviceId: "device-a",
			deleted: false,
		});
		const versionAfterFirstPush = files[0]!.updatedAt;

		await backend.softDeleteFile({
			workspaceId,
			path: "note.md",
			deviceId: "device-a",
		});
		expect(await backend.getFiles(workspaceId)).toHaveLength(0);
		const withDeleted = await backend.getFiles(workspaceId, {
			includeDeleted: true,
		});
		expect(withDeleted).toHaveLength(1);
		expect(withDeleted[0]?.deleted).toBe(true);

		const since = await backend.getFiles(workspaceId, {
			since: versionAfterFirstPush - 1,
			includeDeleted: true,
		});
		expect(since).toHaveLength(1);
	});

	it("generateAssetUploadUrl / pushAsset / getAssets / getAssetDownloadUrl / softDeleteAsset — bearer headers actually authenticate the raw asset routes", async () => {
		const backend = bearerBackend();
		const workspaceId = await backend.createWorkspace("backend-assets-ws");

		const upload = await backend.generateAssetUploadUrl();
		expect(upload.url).toContain("/api/asset/upload");
		// Proof the auth-fix headers are load-bearing, not decorative: the
		// SAME upload URL rejects an unauthenticated request (this is exactly
		// the "bare unauthenticated fetch" defect this package fixes).
		const unauthenticated = await fetch(upload.url, {
			method: "POST",
			body: new Uint8Array([1]),
		});
		expect(unauthenticated.status).toBe(401);

		const bytes = new Uint8Array([137, 80, 78, 71]);
		const uploadResponse = await fetch(upload.url, {
			method: "POST",
			headers: upload.headers,
			body: bytes,
		});
		expect(uploadResponse.status).toBe(200);
		const { storageId } = (await uploadResponse.json()) as {
			storageId: string;
		};
		expect(storageId).toMatch(/^[0-9a-f]{64}$/);

		await backend.pushAsset({
			workspaceId,
			path: "image.assets/pic.png",
			storageId,
			contentHash: storageId,
			deviceId: "device-a",
		});
		const assets = await backend.getAssets(workspaceId);
		expect(assets).toHaveLength(1);
		expect(assets[0]).toMatchObject({
			path: "image.assets/pic.png",
			storageId,
			deleted: false,
		});

		const download = await backend.getAssetDownloadUrl(storageId);
		expect(download?.url).toContain(`/api/asset/${storageId}`);
		const unauthenticatedDownload = await fetch(download!.url);
		expect(unauthenticatedDownload.status).toBe(401);
		const downloadResponse = await fetch(download!.url, {
			headers: download!.headers,
		});
		expect(downloadResponse.status).toBe(200);
		const downloaded = new Uint8Array(await downloadResponse.arrayBuffer());
		expect([...downloaded]).toEqual([...bytes]);

		await backend.softDeleteAsset({
			workspaceId,
			path: "image.assets/pic.png",
			deviceId: "device-a",
		});
		const afterDelete = await backend.getAssets(workspaceId);
		expect(afterDelete[0]?.deleted).toBe(true);
	});

	it("getAssetDownloadUrl returns null only for an empty storageId — a well-formed but never-uploaded hash instead 404s on fetch", async () => {
		const backend = bearerBackend();
		// The Worker's /api/asset/download-url route (apps/www/worker/routes/assets.ts)
		// only short-circuits to {url: null} when the storageId query param
		// itself is empty/missing — it does not check R2 for existence. A
		// syntactically valid but never-uploaded hash gets a real URL back;
		// the 404 only shows up when that URL is actually fetched (the
		// download route DOES check R2).
		expect(await backend.getAssetDownloadUrl("")).toBeNull();

		const download = await backend.getAssetDownloadUrl("never-uploaded-hash");
		expect(download?.url).toContain("/api/asset/never-uploaded-hash");
		const response = await fetch(download!.url, { headers: download!.headers });
		expect(response.status).toBe(404);
	});

	it("a push that violates the storage cap surfaces a distinct, catchable error (R7)", async () => {
		const capped = await startRealWorker({ storageCapBytes: 10 });
		try {
			const backend = createCloudflareBackend({
				baseUrl: capped.baseUrl,
				auth: { kind: "bearer", token: TEST_PASSWORD },
			});
			const workspaceId = await backend.createWorkspace("backend-cap-ws");
			await expect(
				backend.pushFile({
					workspaceId,
					path: "big.md",
					contentHash: "h",
					content: "this content is way bigger than the ten byte cap",
					deviceId: "device-a",
				}),
			).rejects.toMatchObject({ code: "STORAGE_CAP_EXCEEDED", status: 413 });
		} finally {
			await capped.dispose();
		}
	});

	it("cookie-mode auth reaches the same routes (no Authorization header, session cookie carried instead)", async () => {
		// Real browsers attach cookies automatically; a plain Node fetch does
		// not persist a cookie jar across calls, so this test drives the
		// login -> cookie -> authenticated-request sequence manually to prove
		// the SAME route surface is reachable via the cookie credential shape,
		// not just bearer.
		const loginResponse = await fetch(new URL("/api/login", worker.baseUrl), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: TEST_PASSWORD }),
		});
		const setCookie = loginResponse.headers.get("Set-Cookie");
		expect(setCookie).toBeTruthy();
		const cookie = setCookie!.split(";")[0]!;

		const backend = createCloudflareBackend({
			baseUrl: worker.baseUrl,
			auth: { kind: "cookie" },
		});
		// Cookie auth relies on the runtime's own credential attachment
		// (browsers do this automatically for same-origin requests); here we
		// verify the SAME backend code path succeeds once a manually-attached
		// cookie header stands in for that browser behavior.
		const originalFetch = globalThis.fetch;
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			headers.set("Cookie", cookie);
			return originalFetch(input, { ...init, headers });
		}) as typeof fetch;
		try {
			const workspaceId = await backend.createWorkspace("backend-cookie-ws");
			expect(workspaceId).toBe("backend-cookie-ws");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
