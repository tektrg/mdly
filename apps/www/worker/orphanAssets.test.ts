import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runOrphanAssetCleanup } from "./cron.js";
import { fetchWithBearer, jsonBody } from "./testHelpers.js";

async function uploadBytes(byte: number): Promise<string> {
	const response = await fetchWithBearer("/api/asset/upload", {
		method: "POST",
		body: new Uint8Array([byte, byte, byte]),
	});
	const { storageId } = (await response.json()) as { storageId: string };
	return storageId;
}

/**
 * orphan-asset-gc-cron (R5): the nightly Cron Trigger runs the ported
 * `referencedAssetPaths`/`orphanAssetCandidates` functions from
 * worker/orphanAssets.ts, which is a byte-for-byte copy of
 * packages/sync-backend/convex/orphanAssets.ts (confirmed with `diff` — see
 * the delivery report; that comparison runs outside this Workers-runtime
 * test sandbox, which has no access to paths outside this project). This
 * suite proves the CRON WIRING around that ported code: mark-then-delete
 * after the 7-day grace period, and that a referenced asset never gets swept
 * even once its grace period has elapsed.
 */
describe("nightly orphan-asset GC (R5)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("deletes an unreferenced asset's R2 object only after the grace period, and never touches a referenced one", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));

		const workspaceId = "orphan-gc-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const referencedHash = await uploadBytes(1);
		const orphanHash = await uploadBytes(2);

		// note.md references referencedHash via a markdown image pointing into
		// an *.assets folder (orphanAssets.ts's own reachability rule).
		await fetchWithBearer("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "note.md",
				contentHash: "h",
				content: `![pic](note.assets/pic.png)`,
				deviceId: "d",
			}),
		});
		await fetchWithBearer("/api/assets", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "note.assets/pic.png",
				storageId: referencedHash,
				contentHash: referencedHash,
				deviceId: "d",
			}),
		});
		await fetchWithBearer("/api/assets", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "unused.assets/ghost.png",
				storageId: orphanHash,
				contentHash: orphanHash,
				deviceId: "d",
			}),
		});

		// First cron run: marks the unreferenced asset as an orphan candidate;
		// nothing is deleted yet (grace period hasn't elapsed).
		const firstRun = await runOrphanAssetCleanup(env);
		expect(firstRun.marked).toBe(1);
		expect(firstRun.rowsDeleted).toBe(0);
		expect(firstRun.r2ObjectsDeleted).toBe(0);

		vi.setSystemTime(new Date("2026-03-09T00:00:00Z")); // +8 days, past the 7-day grace period

		const secondRun = await runOrphanAssetCleanup(env);
		expect(secondRun.rowsDeleted).toBe(1);
		expect(secondRun.r2ObjectsDeleted).toBe(1);

		const referencedStillDownloadable = await fetchWithBearer(
			`/api/asset/${referencedHash}`,
		);
		expect(referencedStillDownloadable.status).toBe(200);

		const orphanNowGone = await fetchWithBearer(`/api/asset/${orphanHash}`);
		expect(orphanNowGone.status).toBe(404);
	});

	it("an asset that becomes referenced again during the grace period is restored, not deleted", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-01T00:00:00Z"));

		const workspaceId = "orphan-gc-ws-restored";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		const hash = await uploadBytes(3);

		await fetchWithBearer("/api/assets", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "maybe.assets/x.png",
				storageId: hash,
				contentHash: hash,
				deviceId: "d",
			}),
		});
		await runOrphanAssetCleanup(env); // marks it orphaned (nothing references it yet)

		// A note now references it before the grace period elapses.
		await fetchWithBearer("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "note.md",
				contentHash: "h",
				content: `![pic](maybe.assets/x.png)`,
				deviceId: "d",
			}),
		});

		vi.setSystemTime(new Date("2026-04-09T00:00:00Z")); // past the grace period
		const laterRun = await runOrphanAssetCleanup(env);
		expect(laterRun.restored).toBe(1);
		expect(laterRun.rowsDeleted).toBe(0);

		const stillThere = await fetchWithBearer(`/api/asset/${hash}`);
		expect(stillThere.status).toBe(200);
	});
});
