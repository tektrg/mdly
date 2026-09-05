import { describe, expect, it } from "vitest";
import { authedJson, fetchWithBearer, jsonBody } from "./testHelpers.js";

/**
 * QA3a (R6): pushAsset can never leave a DO row pointing at bytes that were
 * never written to R2. Our design puts the guarantee at the Worker route
 * boundary (worker/routes/assets.ts): it `head()`s the R2 object for
 * `storageId` BEFORE calling into the DO, and refuses to call the DO at all
 * if the object doesn't exist — so there is no ordering race to test here,
 * only the refusal itself and its absence of side effects.
 */
describe("pushAsset never leaves a dangling reference (R6)", () => {
	it("rejects pushAsset for a storageId that was never uploaded, and commits no row", async () => {
		const workspaceId = "dangling-ref-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const fabricatedHash = "0".repeat(64);
		const push = await authedJson<{ error: string; code: string }>(
			"/api/assets",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					path: "ghost.png",
					storageId: fabricatedHash,
					contentHash: fabricatedHash,
					deviceId: "device-a",
				}),
			},
		);

		expect(push.status).toBe(409);
		expect(push.body.code).toBe("ASSET_REFERENCE_ERROR");

		const assets = await authedJson<{ assets: unknown[] }>(
			`/api/assets?workspaceId=${workspaceId}`,
		);
		expect(assets.body.assets).toHaveLength(0);
	});

	it("a real upload-then-push round trip never produces a row without a backing R2 object", async () => {
		const workspaceId = "dangling-ref-ws-happy-path";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const uploadResponse = await fetchWithBearer("/api/asset/upload", {
			method: "POST",
			body: new Uint8Array([9, 9, 9]),
		});
		const { storageId } = (await uploadResponse.json()) as {
			storageId: string;
		};

		const push = await authedJson<{ ok: true }>("/api/assets", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "real.png",
				storageId,
				contentHash: storageId,
				deviceId: "device-a",
			}),
		});
		expect(push.body.ok).toBe(true);

		const download = await fetchWithBearer(`/api/asset/${storageId}`);
		expect(download.status).toBe(200);
	});
});
