import { describe, expect, it } from "vitest";
import { authedJson, fetchWithBearer, jsonBody } from "./testHelpers.js";

/**
 * O1-backend-10-methods (R1, R9): every SyncBackend method works for real
 * against the Worker+DO(+R2) stack. Exercised over the real HTTP surface
 * (bearer-authenticated), not by calling DO RPC methods directly, so this
 * proves the Worker's routing/validation layer too.
 */
describe("all 10 SyncBackend methods round-trip (R1)", () => {
	it("getWorkspace / createWorkspace", async () => {
		const missing = await authedJson<{ workspaceId: string | null }>(
			"/api/workspace?name=never-created",
		);
		expect(missing.body.workspaceId).toBeNull();

		const created = await authedJson<{ workspaceId: string }>(
			"/api/workspace",
			{
				method: "POST",
				...jsonBody({ name: "backend-ws" }),
			},
		);
		expect(created.status).toBe(200);
		expect(created.body.workspaceId).toBe("backend-ws");

		const found = await authedJson<{ workspaceId: string | null }>(
			"/api/workspace?name=backend-ws",
		);
		expect(found.body.workspaceId).toBe("backend-ws");
	});

	it("pushFile / getFiles / softDeleteFile", async () => {
		const workspaceId = "backend-ws-files";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const push = await authedJson<{ ok: true; version: number }>("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "note.md",
				contentHash: "hash-1",
				content: "# Hello",
				deviceId: "device-a",
			}),
		});
		expect(push.body.ok).toBe(true);
		expect(push.body.version).toBeGreaterThan(0);

		const list = await authedJson<{
			files: { path: string; content: string; deleted: boolean }[];
		}>(`/api/files?workspaceId=${workspaceId}`);
		expect(list.body.files).toHaveLength(1);
		expect(list.body.files[0]).toMatchObject({
			path: "note.md",
			content: "# Hello",
			deleted: false,
		});

		await fetchWithBearer("/api/files/delete", {
			method: "POST",
			...jsonBody({ workspaceId, path: "note.md", deviceId: "device-a" }),
		});

		const afterDelete = await authedJson<{ files: unknown[] }>(
			`/api/files?workspaceId=${workspaceId}`,
		);
		expect(afterDelete.body.files).toHaveLength(0);

		const withDeleted = await authedJson<{ files: { deleted: boolean }[] }>(
			`/api/files?workspaceId=${workspaceId}&includeDeleted=true`,
		);
		expect(withDeleted.body.files).toHaveLength(1);
		expect(withDeleted.body.files[0]?.deleted).toBe(true);
	});

	it("generateAssetUploadUrl / pushAsset / getAssets / getAssetDownloadUrl / softDeleteAsset", async () => {
		const workspaceId = "backend-ws-assets";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const uploadUrlResponse = await authedJson<{ uploadUrl: string }>(
			"/api/asset/upload-url",
		);
		expect(uploadUrlResponse.body.uploadUrl).toContain("/api/asset/upload");

		const bytes = new Uint8Array([137, 80, 78, 71]); // fake PNG-ish bytes
		const uploadResponse = await fetchWithBearer("/api/asset/upload", {
			method: "POST",
			body: bytes,
		});
		const { storageId } = (await uploadResponse.json()) as {
			storageId: string;
		};
		expect(storageId).toMatch(/^[0-9a-f]{64}$/);

		const pushed = await authedJson<{ ok: true; version: number }>(
			"/api/assets",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					path: "image.assets/pic.png",
					storageId,
					contentHash: storageId,
					deviceId: "device-a",
				}),
			},
		);
		expect(pushed.body.ok).toBe(true);

		const assets = await authedJson<{
			assets: {
				path: string;
				storageId: string;
				contentHash: string;
				deleted: boolean;
			}[];
		}>(`/api/assets?workspaceId=${workspaceId}`);
		expect(assets.body.assets).toHaveLength(1);
		expect(assets.body.assets[0]).toMatchObject({
			path: "image.assets/pic.png",
			storageId,
			contentHash: storageId,
			deleted: false,
		});

		const downloadUrlResponse = await authedJson<{ url: string | null }>(
			`/api/asset/download-url?storageId=${storageId}`,
		);
		expect(downloadUrlResponse.body.url).toContain(`/api/asset/${storageId}`);

		const downloadResponse = await fetchWithBearer(`/api/asset/${storageId}`);
		const downloaded = new Uint8Array(await downloadResponse.arrayBuffer());
		expect([...downloaded]).toEqual([...bytes]);

		await fetchWithBearer("/api/assets/delete", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "image.assets/pic.png",
				deviceId: "device-a",
			}),
		});
		const afterDelete = await authedJson<{ assets: { deleted: boolean }[] }>(
			`/api/assets?workspaceId=${workspaceId}`,
		);
		expect(afterDelete.body.assets[0]?.deleted).toBe(true);
	});

	it("getAssetDownloadUrl returns null for a storageId that was never uploaded", async () => {
		const response = await authedJson<{ url: string | null }>(
			"/api/asset/download-url?storageId=",
		);
		expect(response.body.url).toBeNull();
	});
});
