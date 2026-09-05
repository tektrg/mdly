import { describe, expect, it } from "vitest";
import {
	authedJson,
	fetchNoAuth,
	fetchWithBearer,
	jsonBody,
} from "./testHelpers.js";

/**
 * Stage 5b — closes charter R36: turning cloud sync OFF for a workspace must
 * actually delete that workspace's Cloudflare copy (notes + images), not
 * just stop pushing to it. "Off" means gone (the user's 2026-09-01
 * decision).
 */

async function uploadBytes(byte: number): Promise<string> {
	const response = await fetchWithBearer("/api/asset/upload", {
		method: "POST",
		body: new Uint8Array([byte, byte, byte]),
	});
	const { storageId } = (await response.json()) as { storageId: string };
	return storageId;
}

describe("delete-workspace route (R36)", () => {
	it("removes the workspace's registry entry, files and assets, and list-workspaces stops returning it", async () => {
		const workspaceId = "delete-me";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		await fetchWithBearer("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "note.md",
				contentHash: "h",
				content: "hello",
				deviceId: "d",
			}),
		});

		const beforeList = await authedJson<{ workspaces: { name: string }[] }>(
			"/api/workspaces",
		);
		expect(beforeList.body.workspaces.map((w) => w.name)).toContain(
			workspaceId,
		);

		const deleteResponse = await fetchWithBearer("/api/workspace/delete", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		expect(deleteResponse.status).toBe(200);
		const deleteBody = (await deleteResponse.json()) as { ok: boolean };
		expect(deleteBody.ok).toBe(true);

		const afterList = await authedJson<{ workspaces: { name: string }[] }>(
			"/api/workspaces",
		);
		expect(afterList.body.workspaces.map((w) => w.name)).not.toContain(
			workspaceId,
		);

		// The DO instance still exists (idFromName is deterministic, DOs are
		// never "deleted" — only their storage is wiped), so its files list is
		// simply empty, not an error.
		const filesResponse = await fetchWithBearer(
			`/api/files?workspaceId=${workspaceId}`,
		);
		const filesBody = (await filesResponse.json()) as {
			files: unknown[];
		};
		expect(filesBody.files).toHaveLength(0);
	});

	it("CROSS-WORKSPACE SAFETY (the trap): deleting one workspace never removes an R2 asset another opted-in workspace still references", async () => {
		const sharedHash = await uploadBytes(42);

		const workspaceA = "shared-asset-ws-a";
		const workspaceB = "shared-asset-ws-b";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceA }),
		});
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceB }),
		});

		// Both workspaces reference the SAME content-addressed hash (identical
		// image bytes uploaded once, pushed as an asset row in each workspace).
		await fetchWithBearer("/api/assets", {
			method: "POST",
			...jsonBody({
				workspaceId: workspaceA,
				path: "pic.assets/shared.png",
				storageId: sharedHash,
				contentHash: sharedHash,
				deviceId: "d",
			}),
		});
		await fetchWithBearer("/api/assets", {
			method: "POST",
			...jsonBody({
				workspaceId: workspaceB,
				path: "pic.assets/shared.png",
				storageId: sharedHash,
				contentHash: sharedHash,
				deviceId: "d",
			}),
		});

		const sanity = await fetchWithBearer(`/api/asset/${sharedHash}`);
		expect(sanity.status).toBe(200);

		// Delete workspace A only.
		const deleteResponse = await fetchWithBearer("/api/workspace/delete", {
			method: "POST",
			...jsonBody({ name: workspaceA }),
		});
		expect(deleteResponse.status).toBe(200);

		// Workspace A is gone from the registry...
		const list = await authedJson<{ workspaces: { name: string }[] }>(
			"/api/workspaces",
		);
		expect(list.body.workspaces.map((w) => w.name)).not.toContain(workspaceA);
		expect(list.body.workspaces.map((w) => w.name)).toContain(workspaceB);

		// ...but the shared R2 object MUST still be downloadable, because
		// workspace B's asset row still references the same hash.
		const stillThere = await fetchWithBearer(`/api/asset/${sharedHash}`);
		expect(stillThere.status).toBe(200);

		// And workspace B's own asset listing is untouched.
		const bAssets = await fetchWithBearer(
			`/api/assets?workspaceId=${workspaceB}`,
		);
		const bAssetsBody = (await bAssets.json()) as {
			assets: { path: string; storageId: string }[];
		};
		expect(bAssetsBody.assets).toHaveLength(1);
		expect(bAssetsBody.assets[0]?.storageId).toBe(sharedHash);
	});

	it("deleting the LAST workspace referencing a hash actually removes the R2 object", async () => {
		const hash = await uploadBytes(7);
		const workspaceId = "sole-owner-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		await fetchWithBearer("/api/assets", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "pic.assets/only.png",
				storageId: hash,
				contentHash: hash,
				deviceId: "d",
			}),
		});
		expect((await fetchWithBearer(`/api/asset/${hash}`)).status).toBe(200);

		await fetchWithBearer("/api/workspace/delete", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		expect((await fetchWithBearer(`/api/asset/${hash}`)).status).toBe(404);
	});

	it("is idempotent — deleting an already-deleted workspace succeeds quietly", async () => {
		const workspaceId = "delete-twice";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const first = await fetchWithBearer("/api/workspace/delete", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		expect(first.status).toBe(200);

		const second = await fetchWithBearer("/api/workspace/delete", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		expect(second.status).toBe(200);
		const secondBody = (await second.json()) as { ok: boolean };
		expect(secondBody.ok).toBe(true);
	});

	it("is idempotent for a workspace name that was never created at all", async () => {
		const response = await fetchWithBearer("/api/workspace/delete", {
			method: "POST",
			...jsonBody({ name: "never-existed-at-all" }),
		});
		expect(response.status).toBe(200);
	});

	it("rejects an unauthenticated request like every other /api/* route (R40)", async () => {
		const response = await fetchNoAuth("/api/workspace/delete", {
			method: "POST",
			...jsonBody({ name: "whatever" }),
		});
		expect(response.status).toBe(401);
		const text = await response.text();
		expect(text).toBe("");
	});

	it("requires a name in the body", async () => {
		const response = await fetchWithBearer("/api/workspace/delete", {
			method: "POST",
			...jsonBody({}),
		});
		expect(response.status).toBe(400);
	});
});
