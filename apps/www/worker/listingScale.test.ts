import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runOrphanAssetCleanup } from "./cron.js";
import { upsertAsset } from "./durableObject/assets.js";
import { upsertFile } from "./durableObject/files.js";
import {
	authedJson,
	fetchWithBearer,
	jsonBody,
	workspaceDoStub,
} from "./testHelpers.js";

/**
 * Round-8 B1 row-count regression coverage: the page budget used to bound
 * bytes only, and the rowid-IN refetch needed one bound parameter per row
 * against DO SQLite's 100-parameter cap — so every workspace over 100 rows
 * 500'd on listing. Pages are now bounded by bytes AND row count with a
 * fixed handful of scalar params. These tests drive the real HTTP routes at
 * realistic scale (thousands of rows, seeded direct for speed — every byte
 * asserted crosses the real route).
 */

const ROW_COUNTS = [1, 99, 100, 101, 500, 2000, 5000] as const;

function pad(i: number): string {
	return String(i).padStart(4, "0");
}

async function seedFiles(workspaceId: string, count: number): Promise<void> {
	const stub = workspaceDoStub(workspaceId);
	await runInDurableObject(stub, (_instance, state) => {
		for (let i = 0; i < count; i++) {
			upsertFile(state.storage.sql, {
				path: `f-${pad(i)}.md`,
				contentHash: `h-${i}`,
				content: `c-${pad(i)}`,
				deviceId: "d",
			});
		}
	});
}

async function seedAssets(workspaceId: string, count: number): Promise<void> {
	const stub = workspaceDoStub(workspaceId);
	await runInDurableObject(stub, (_instance, state) => {
		for (let i = 0; i < count; i++) {
			upsertAsset(state.storage.sql, {
				path: `a-${pad(i)}.png`,
				hash: `hash-${i}`,
				deviceId: "d",
			});
		}
	});
}

async function createWorkspace(workspaceId: string): Promise<void> {
	await fetchWithBearer("/api/workspace", {
		method: "POST",
		...jsonBody({ name: workspaceId }),
	});
}

async function collectFilePages(
	workspaceId: string,
): Promise<{ paths: string[]; contents: Map<string, string>; pages: number }> {
	const paths: string[] = [];
	const contents = new Map<string, string>();
	let cursor: { updatedAt: number; path: string } | null = null;
	let pages = 0;
	do {
		const params = new URLSearchParams({ workspaceId });
		if (cursor) {
			params.set("cursorUpdatedAt", String(cursor.updatedAt));
			params.set("cursorPath", cursor.path);
		}
		const res = await authedJson<{
			files: { path: string; content: string }[];
			nextCursor: { updatedAt: number; path: string } | null;
		}>(`/api/files?${params.toString()}`);
		expect(res.status).toBe(200);
		for (const f of res.body.files) {
			paths.push(f.path);
			contents.set(f.path, f.content);
		}
		cursor = res.body.nextCursor;
		pages++;
		expect(pages).toBeLessThan(100);
	} while (cursor);
	return { paths, contents, pages };
}

async function collectAssetPages(workspaceId: string): Promise<string[]> {
	const paths: string[] = [];
	let cursor: { updatedAt: number; path: string } | null = null;
	let pages = 0;
	do {
		const params = new URLSearchParams({ workspaceId });
		if (cursor) {
			params.set("cursorUpdatedAt", String(cursor.updatedAt));
			params.set("cursorPath", cursor.path);
		}
		const res = await authedJson<{
			assets: { path: string }[];
			nextCursor: { updatedAt: number; path: string } | null;
		}>(`/api/assets?${params.toString()}`);
		expect(res.status).toBe(200);
		for (const a of res.body.assets) paths.push(a.path);
		cursor = res.body.nextCursor;
		pages++;
		expect(pages).toBeLessThan(100);
	} while (cursor);
	return paths;
}

describe("listing row counts (B1 regression)", () => {
	for (const count of ROW_COUNTS) {
		it(`GET /api/files returns 200 with the complete set at ${count} rows`, async () => {
			const workspaceId = `scale-files-${count}`;
			await createWorkspace(workspaceId);
			await seedFiles(workspaceId, count);

			const { paths, contents } = await collectFilePages(workspaceId);
			// Exact order, exact content, no duplicates, no misses.
			expect(paths).toHaveLength(count);
			expect(new Set(paths).size).toBe(count);
			for (let i = 0; i < count; i++) {
				expect(paths[i]).toBe(`f-${pad(i)}.md`);
				expect(contents.get(`f-${pad(i)}.md`)).toBe(`c-${pad(i)}`);
			}
		}, 120000);

		it(`GET /api/assets returns 200 with the complete set at ${count} rows`, async () => {
			const workspaceId = `scale-assets-${count}`;
			await createWorkspace(workspaceId);
			await seedAssets(workspaceId, count);

			const paths = await collectAssetPages(workspaceId);
			expect(paths).toHaveLength(count);
			expect(new Set(paths).size).toBe(count);
			for (let i = 0; i < count; i++) {
				expect(paths[i]).toBe(`a-${pad(i)}.png`);
			}
		}, 120000);
	}

	it("runOrphanAssetCleanup completes on a 300+ note workspace", async () => {
		const workspaceId = "scale-cron-ws";
		await createWorkspace(workspaceId);
		const stub = workspaceDoStub(workspaceId);
		await runInDurableObject(stub, (_instance, state) => {
			for (let i = 0; i < 350; i++) {
				upsertFile(state.storage.sql, {
					path: `n-${pad(i)}.md`,
					contentHash: `h-${i}`,
					content: i === 0 ? "![a](k-0000.png)\n![b](k-0001.png)" : `note ${i}`,
					deviceId: "d",
				});
			}
			for (let i = 0; i < 12; i++) {
				upsertAsset(state.storage.sql, {
					path: `k-${pad(i)}.png`,
					hash: `hash-${i}`,
					deviceId: "d",
				});
			}
		});

		const run = await runOrphanAssetCleanup(env);
		// Nothing past grace on a first run anywhere in the isolate.
		expect(run.rowsDeleted).toBe(0);

		// My 10 orphans (and only the assertion about them) are marked —
		// read back directly so this holds regardless of what other
		// workspaces in the isolate contribute to the global counts, and
		// regardless of -t filtering.
		const check = workspaceDoStub("scale-cron-ws");
		const gc = await check.listAssetsForGc({ cursor: null });
		expect(gc.assets.filter((a) => a.orphanedAt !== undefined)).toHaveLength(
			10,
		);
		expect(gc.nextCursor).toBeNull();
	}, 120000);
});
