import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runOrphanAssetCleanup } from "./cron.js";
import { orphanAssetCandidates } from "./orphanAssets.js";
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

	/**
	 * Round-3 P0 regression test: the GC matcher (`normalizeWorkspacePath`)
	 * must be byte-preserving within segments. Trimming it once rewired this
	 * scan so still-referenced images were reported as orphans and deleted by
	 * the cron. Leading/trailing spaces are legal in filenames on macOS/Linux.
	 */
	it("a referenced asset whose path has a leading/trailing space is NOT an orphan", () => {
		const files = [
			{
				path: "note.md",
				content: "![shot](note.assets/%20shot.png)",
				deleted: false,
			},
		];
		const assets = [{ path: "note.assets/ shot.png", deleted: false }];
		expect(orphanAssetCandidates(files, assets)).toEqual([]);
	});

	it("a reference under a whitespace-only directory still matches its asset", () => {
		const files = [
			{
				path: "note.md",
				content: "![](%20/a.assets/i.png)",
				deleted: false,
			},
		];
		const assets = [{ path: " /a.assets/i.png", deleted: false }];
		expect(orphanAssetCandidates(files, assets)).toEqual([]);
	});

	/**
	 * Round-4 P0: the writer and the GC matcher must agree exactly. The rule
	 * is store-byte-for-byte-or-reject — no trimming — so a spaced asset
	 * uploaded through the real route keeps its exact path, matches its
	 * markdown reference on every scan, and survives a FULL cron cycle
	 * including the grace period. Drives the real routes and the real
	 * `runOrphanAssetCleanup`: the previous regression test passed while the
	 * bug was live because it hand-built rows instead of posting.
	 */
	it("spaced asset paths uploaded via the route survive the full GC cycle including the grace period", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-01T00:00:00Z"));

		const workspaceId = "orphan-gc-spaced";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		const spacedHash = await uploadBytes(11);
		const dirSpaceHash = await uploadBytes(12);

		// Both uploads succeed as sent — a 400 here was round 3's regression
		// (whitespace-only directory rejected), a silent rename was round 2's.
		for (const [path, hash] of [
			["note.assets/ shot.png", spacedHash],
			[" /a.assets/i.png", dirSpaceHash],
		] as const) {
			const pushed = await fetchWithBearer("/api/assets", {
				method: "POST",
				...jsonBody({ workspaceId, path, storageId: hash, deviceId: "d" }),
			});
			expect(pushed.status).toBe(200);
		}

		// Stored byte-for-byte, not renamed.
		const listed = await fetchWithBearer(
			`/api/assets?workspaceId=${workspaceId}`,
		);
		const { assets } = (await listed.json()) as { assets: { path: string }[] };
		expect(assets.map((a) => a.path).sort()).toEqual([
			" /a.assets/i.png",
			"note.assets/ shot.png",
		]);

		await fetchWithBearer("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "note.md",
				contentHash: "h",
				content: `![a](note.assets/%20shot.png)\n![b](%20/a.assets/i.png)`,
				deviceId: "d",
			}),
		});

		// Referenced on the very first scan: nothing marked.
		const firstRun = await runOrphanAssetCleanup(env);
		expect(firstRun.rowsDeleted).toBe(0);
		expect(firstRun.r2ObjectsDeleted).toBe(0);

		// Past the 7-day grace period: still nothing deleted, both objects
		// still downloadable while the note still links to them.
		vi.setSystemTime(new Date("2026-05-09T00:00:00Z"));
		const secondRun = await runOrphanAssetCleanup(env);
		expect(secondRun.rowsDeleted).toBe(0);
		expect(secondRun.r2ObjectsDeleted).toBe(0);

		for (const hash of [spacedHash, dirSpaceHash]) {
			const download = await fetchWithBearer(`/api/asset/${hash}`);
			expect(download.status).toBe(200);
		}
	});
});
