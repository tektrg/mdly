import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { upsertAsset } from "./durableObject/assets.js";
import {
	errorToResponseBody,
	StorageCapExceededError,
	toRpcError,
} from "./durableObject/errors.js";
import { upsertFile } from "./durableObject/files.js";
import {
	authedJson,
	fetchNoAuth,
	fetchWithBearer,
	jsonBody,
	workspaceDoStub,
} from "./testHelpers.js";

/**
 * BUG-LW1 Tasks 2+3, server side: batch push (one cap check, one version
 * bump/broadcast for many files) and the cheap 1-row version endpoint.
 * Existing single-file POST /api/files behaviour is covered by
 * backend.test.ts / storageCap.test.ts and must be unchanged.
 */
describe("batch push endpoint (Task 2)", () => {
	it("pushes many files with a single version bump", async () => {
		const workspaceId = "batch-ws-basic";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const before = await authedJson<{ version: number }>(
			`/api/version?workspaceId=${workspaceId}`,
		);
		expect(before.body.version).toBe(0);

		const batch = await authedJson<{ ok: true; version: number }>(
			"/api/files/batch",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					files: [
						{ path: "a.md", contentHash: "h1", content: "aaa", deviceId: "d" },
						{ path: "b.md", contentHash: "h2", content: "bbb", deviceId: "d" },
						{ path: "c.md", contentHash: "h3", content: "ccc", deviceId: "d" },
					],
				}),
			},
		);
		expect(batch.body.ok).toBe(true);
		// One bump for the whole batch, not one per file.
		expect(batch.body.version).toBe(before.body.version + 1);

		const files = await authedJson<{ files: { path: string }[] }>(
			`/api/files?workspaceId=${workspaceId}`,
		);
		expect(files.body.files.map((f) => f.path).sort()).toEqual([
			"a.md",
			"b.md",
			"c.md",
		]);
	});

	it("a batch that together exceeds the cap is rejected whole — nothing written", async () => {
		const workspaceId = "batch-ws-cap";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const chunk = "y".repeat(900_000); // 3x = 2.7MB > the 2MB test cap
		const batch = await authedJson<{ error: string; code: string }>(
			"/api/files/batch",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					files: [
						{ path: "a.md", contentHash: "h", content: chunk, deviceId: "d" },
						{ path: "b.md", contentHash: "h", content: chunk, deviceId: "d" },
						{ path: "c.md", contentHash: "h", content: chunk, deviceId: "d" },
					],
				}),
			},
		);
		expect(batch.status).toBe(413);
		expect(batch.body.code).toBe("STORAGE_CAP_EXCEEDED");

		const files = await authedJson<{ files: unknown[] }>(
			`/api/files?workspaceId=${workspaceId}`,
		);
		expect(files.body.files).toHaveLength(0);
	});

	it("the per-file comment-log slot invariant still rejects a violating batch whole", async () => {
		const workspaceId = "batch-ws-invariant";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		// Register a browser device (takes slot 2), which may never write the
		// canonical (unsuffixed) comment log.
		await fetchWithBearer("/api/device/register", {
			method: "POST",
			...jsonBody({ workspaceId, deviceId: "browser-1" }),
		});

		const batch = await authedJson<{ error: string; code: string }>(
			"/api/files/batch",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					files: [
						{
							path: "innocent.md",
							contentHash: "h",
							content: "x",
							deviceId: "browser-1",
						},
						{
							path: ".mdly/comments/note.jsonl",
							contentHash: "h",
							content: "[]",
							deviceId: "browser-1",
						},
					],
				}),
			},
		);
		expect(batch.status).toBe(403);
		expect(batch.body.code).toBe("SLOT_INVARIANT_VIOLATION");

		// Nothing from the batch was written — not even the innocent file.
		const files = await authedJson<{ files: unknown[] }>(
			`/api/files?workspaceId=${workspaceId}&includeDeleted=true`,
		);
		expect(files.body.files).toHaveLength(0);
	});

	it("oversized and malformed batches are rejected with a clear error", async () => {
		const workspaceId = "batch-ws-limits";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const tooMany = Array.from({ length: 101 }, (_, i) => ({
			path: `f-${i}.md`,
			contentHash: "h",
			content: "x",
			deviceId: "d",
		}));
		const oversized = await authedJson<{ error: string; code: string }>(
			"/api/files/batch",
			{
				method: "POST",
				...jsonBody({ workspaceId, files: tooMany }),
			},
		);
		expect(oversized.status).toBe(400);
		expect(oversized.body.code).toBe("BATCH_TOO_LARGE");
		expect(oversized.body.error).toContain("100");

		const empty = await authedJson<{ error: string; code: string }>(
			"/api/files/batch",
			{
				method: "POST",
				...jsonBody({ workspaceId, files: [] }),
			},
		);
		expect(empty.status).toBe(400);
		expect(empty.body.code).toBe("BATCH_EMPTY");
		expect(empty.body.error).toContain("no files");

		const missing = await authedJson("/api/files/batch", {
			method: "POST",
			...jsonBody({ workspaceId }),
		});
		expect(missing.status).toBe(400);
	});
});

describe("cheap version endpoint (Task 3)", () => {
	it("returns the current version and tracks pushes one-to-one", async () => {
		const workspaceId = "version-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const v0 = await authedJson<{ version: number }>(
			`/api/version?workspaceId=${workspaceId}`,
		);
		expect(v0.body.version).toBe(0);

		await authedJson("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "n.md",
				contentHash: "h",
				content: "hi",
				deviceId: "d",
			}),
		});
		const v1 = await authedJson<{ version: number }>(
			`/api/version?workspaceId=${workspaceId}`,
		);
		expect(v1.body.version).toBe(v0.body.version + 1);

		const missing = await authedJson("/api/version");
		expect(missing.status).toBe(400);
	});
});

describe("round-2 fixes", () => {
	it("unauthenticated requests to the batch and version routes get 401", async () => {
		const batch = await fetchNoAuth("/api/files/batch", {
			method: "POST",
			...jsonBody({ workspaceId: "w", files: [] }),
		});
		expect(batch.status).toBe(401);

		const version = await fetchNoAuth("/api/version?workspaceId=w");
		expect(version.status).toBe(401);

		const wrongBearer = await fetchWithBearer(
			"/api/version?workspaceId=w",
			{},
			"wrong-token",
		);
		expect(wrongBearer.status).toBe(401);
	});

	it("a batch that throws mid-write rolls everything back: zero files, version and byte counter unchanged", async () => {
		const workspaceId = "batch-rollback-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		const stub = workspaceDoStub(workspaceId);
		const versionBefore = await stub.getVersion();

		// Small files clear every validation gate (cap, byte limit, slot
		// invariant), so the write loop — and `transactionSync` — is genuinely
		// entered. The throw comes from SQL parameter binding: workerd
		// stringifies bound objects via `toString()`, so an object whose
		// `toString` throws blows up on the INSERT of entry 3 of 4, after two
		// files were already written inside the transaction. It must run via
		// `runInDurableObject` because the RPC boundary's structured clone
		// would strip the throwing method before it ever reached the DO.
		const result = await runInDurableObject(stub, (instance) => {
			const evil = {
				toString(): string {
					throw new Error("evil toString");
				},
			};
			return instance.pushFilesBatch({
				files: [
					{ path: "r1.md", contentHash: "h", content: "one", deviceId: "d" },
					{ path: "r2.md", contentHash: "h", content: "two", deviceId: "d" },
					{
						path: "bad.md",
						contentHash: "h",
						content: evil as unknown as string,
						deviceId: "d",
					},
					{
						path: "r3.md",
						contentHash: "h",
						content: "three",
						deviceId: "d",
					},
				],
			});
		});
		expect(result.ok).toBe(false);

		const files = await authedJson<{ files: unknown[] }>(
			`/api/files?workspaceId=${workspaceId}&includeDeleted=true`,
		);
		expect(files.body.files).toHaveLength(0);
		expect(await stub.getVersion()).toBe(versionBefore);

		// Byte counter unchanged: two 900KB pushes still fit under the 2MB
		// test cap (they would 413 had the rolled-back bytes leaked), and a
		// third one 413s exactly at the real boundary.
		const big = "z".repeat(900_000);
		for (const name of ["s1.md", "s2.md"]) {
			const push = await authedJson<{ ok: boolean }>("/api/files", {
				method: "POST",
				...jsonBody({
					workspaceId,
					path: name,
					contentHash: "h",
					content: big,
					deviceId: "d",
				}),
			});
			expect(push.body.ok).toBe(true);
		}
		const third = await authedJson<{ error: string; code: string }>(
			"/api/files",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					path: "s3.md",
					contentHash: "h",
					content: big,
					deviceId: "d",
				}),
			},
		);
		expect(third.status).toBe(413);
		expect(third.body.code).toBe("STORAGE_CAP_EXCEEDED");
	});

	it("a batch over the byte limit is rejected 413 before anything is written", async () => {
		const workspaceId = "batch-ws-bytelimit";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		// 10 x 900KB = 9MB > the 8MB batch byte limit (each file is under
		// the 2MB workspace cap, so only the batch guard can fire).
		const chunk = "y".repeat(900_000);
		const batch = await authedJson<{ error: string; code: string }>(
			"/api/files/batch",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					files: Array.from({ length: 10 }, (_, i) => ({
						path: `f-${i}.md`,
						contentHash: "h",
						content: chunk,
						deviceId: "d",
					})),
				}),
			},
		);
		expect(batch.status).toBe(413);
		expect(batch.body.code).toBe("BATCH_BYTE_LIMIT");

		const files = await authedJson<{ files: unknown[] }>(
			`/api/files?workspaceId=${workspaceId}`,
		);
		expect(files.body.files).toHaveLength(0);
		const version = await authedJson<{ version: number }>(
			`/api/version?workspaceId=${workspaceId}`,
		);
		expect(version.body.version).toBe(0);
	});

	it("a batch of pure overwrites within cap succeeds", async () => {
		const workspaceId = "batch-ws-overwrite";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		// 2 x 900KB = 1.8MB of the 2MB test cap. Re-pushing both is net-zero.
		const chunk = "w".repeat(900_000);
		for (const name of ["a.md", "b.md"]) {
			const push = await authedJson<{ ok: boolean }>("/api/files", {
				method: "POST",
				...jsonBody({
					workspaceId,
					path: name,
					contentHash: "h",
					content: chunk,
					deviceId: "d",
				}),
			});
			expect(push.body.ok).toBe(true);
		}

		const before = await authedJson<{ version: number }>(
			`/api/version?workspaceId=${workspaceId}`,
		);
		const batch = await authedJson<{ ok: boolean; version: number }>(
			"/api/files/batch",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					files: ["a.md", "b.md"].map((path) => ({
						path,
						contentHash: "h",
						content: chunk,
						deviceId: "d",
					})),
				}),
			},
		);
		expect(batch.body.ok).toBe(true);
		expect(batch.body.version).toBe(before.body.version + 1);
	});

	it("path evasion spellings are canonicalised before the slot check; traversal is rejected", async () => {
		const workspaceId = "batch-ws-paths";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		// Registered browser (takes slot 2): may never write the canonical log.
		await fetchWithBearer("/api/device/register", {
			method: "POST",
			...jsonBody({ workspaceId, deviceId: "browser-1" }),
		});

		const pushSingle = (path: string) =>
			authedJson<{ error: string; code: string }>("/api/files", {
				method: "POST",
				...jsonBody({
					workspaceId,
					path,
					contentHash: "h",
					content: "[]",
					deviceId: "browser-1",
				}),
			});

		// Control: the plain canonical path is blocked...
		const control = await pushSingle(".mdly/comments/canon.jsonl");
		expect(control.status).toBe(403);
		expect(control.body.code).toBe("SLOT_INVARIANT_VIOLATION");

		// ...and so are the structural evasion spellings. Case is not
		// structural: `.JSONL` still matches the guard.
		for (const evasive of [
			"./.mdly/comments/dot.jsonl",
			".mdly/comments/upper.JSONL",
		]) {
			const blocked = await pushSingle(evasive);
			expect.soft(blocked.status, evasive).toBe(403);
			expect.soft(blocked.body.code, evasive).toBe("SLOT_INVARIANT_VIOLATION");
		}

		// Trailing whitespace is NOT an evasion: `space.jsonl ` is a
		// different, harmless file from `space.jsonl`. The rule is
		// store-byte-for-byte-or-reject, so it is stored as sent.
		const spaced = await pushSingle(".mdly/comments/space.jsonl ");
		expect(spaced.status).toBe(200);
		const spacedList = await authedJson<{ files: { path: string }[] }>(
			`/api/files?workspaceId=${workspaceId}&includeDeleted=true`,
		);
		expect(spacedList.body.files.map((f) => f.path)).toContain(
			".mdly/comments/space.jsonl ",
		);

		// Batch path: an evasion inside a batch rejects the whole batch.
		const batch = await authedJson<{ error: string; code: string }>(
			"/api/files/batch",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					files: [
						{
							path: "batch-innocent.md",
							contentHash: "h",
							content: "x",
							deviceId: "browser-1",
						},
						{
							path: "./.mdly/comments/batch-evasion.jsonl",
							contentHash: "h",
							content: "[]",
							deviceId: "browser-1",
						},
					],
				}),
			},
		);
		expect(batch.status).toBe(403);
		expect(batch.body.code).toBe("SLOT_INVARIANT_VIOLATION");

		// Traversal escapes the workspace root: rejected, never stored.
		const traversal = await pushSingle("../.mdly/comments/escape.jsonl");
		expect(traversal.status).toBe(400);
		expect(traversal.body.code).toBe("INVALID_PATH");

		const traversalBatch = await authedJson<{ error: string; code: string }>(
			"/api/files/batch",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					files: [
						{
							path: "traversal-innocent.md",
							contentHash: "h",
							content: "x",
							deviceId: "browser-1",
						},
						{
							path: "../escape2.md",
							contentHash: "h",
							content: "x",
							deviceId: "browser-1",
						},
					],
				}),
			},
		);
		expect(traversalBatch.status).toBe(400);
		expect(traversalBatch.body.code).toBe("INVALID_PATH");

		// Blocked and escaping paths left nothing behind — only the
		// byte-for-byte stored `space.jsonl ` row exists.
		const files = await authedJson<{ files: { path: string }[] }>(
			`/api/files?workspaceId=${workspaceId}&includeDeleted=true`,
		);
		expect(files.body.files.map((f) => f.path).sort()).toEqual([
			".mdly/comments/space.jsonl ",
		]);

		// And structural normalisation still collapses: "./canon-store.md"
		// from an unregistered device lands as "canon-store.md".
		const stored = await authedJson<{ ok: boolean }>("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "./canon-store.md",
				contentHash: "h",
				content: "hi",
				deviceId: "desktop-1",
			}),
		});
		expect(stored.body.ok).toBe(true);
		const listed = await authedJson<{ files: { path: string }[] }>(
			`/api/files?workspaceId=${workspaceId}`,
		);
		expect(listed.body.files.map((f) => f.path).sort()).toEqual([
			".mdly/comments/space.jsonl ",
			"canon-store.md",
		]);
	});

	it("a correctly-slotted browser write to its suffixed comment log succeeds", async () => {
		const workspaceId = "batch-ws-slot-ok";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		// First browser registration takes slot 2.
		const reg = await authedJson<{ slot: number }>("/api/device/register", {
			method: "POST",
			...jsonBody({ workspaceId, deviceId: "browser-9" }),
		});
		expect(reg.body.slot).toBe(2);

		const push = await authedJson<{ ok: boolean; version: number }>(
			"/api/files",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					path: ".mdly/comments/note 2.jsonl",
					contentHash: "h",
					content: "[]",
					deviceId: "browser-9",
				}),
			},
		);
		expect(push.body.ok).toBe(true);

		const files = await authedJson<{ files: { path: string }[] }>(
			`/api/files?workspaceId=${workspaceId}`,
		);
		expect(files.body.files.map((f) => f.path)).toEqual([
			".mdly/comments/note 2.jsonl",
		]);
	});
});

describe("round-3 fixes", () => {
	it("a 33MB single push is rejected 413 without leaking RPC internals", async () => {
		const workspaceId = "single-ws-bytes";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		// Over the 16MB total request cap: must fail in the route, before the
		// RPC call. Without the guard this dies inside RPC with a 500
		// leaking "Serialized RPC arguments ... 32MiB ...".
		const huge = "x".repeat(33 * 1024 * 1024);
		const push = await authedJson<{ error: string; code: string }>(
			"/api/files",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					path: "huge.md",
					contentHash: "h",
					content: huge,
					deviceId: "d",
				}),
			},
		);
		expect(push.status).toBe(413);
		expect(push.body.code).toBe("REQUEST_TOO_LARGE");
		expect(JSON.stringify(push.body)).not.toContain("Serialized RPC");

		const files = await authedJson<{ files: unknown[] }>(
			`/api/files?workspaceId=${workspaceId}`,
		);
		expect(files.body.files).toHaveLength(0);
	});

	it("a 10MB single push is rejected by the content cap with FILE_TOO_LARGE", async () => {
		const workspaceId = "single-ws-content";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		// Under the 16MB total cap but over the 8MB content cap: the
		// content-specific guard fires.
		const big = "x".repeat(10 * 1024 * 1024);
		const push = await authedJson<{ error: string; code: string }>(
			"/api/files",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					path: "big.md",
					contentHash: "h",
					content: big,
					deviceId: "d",
				}),
			},
		);
		expect(push.status).toBe(413);
		expect(push.body.code).toBe("FILE_TOO_LARGE");
		expect(JSON.stringify(push.body)).not.toContain("Serialized RPC");

		const files = await authedJson<{ files: unknown[] }>(
			`/api/files?workspaceId=${workspaceId}`,
		);
		expect(files.body.files).toHaveLength(0);
	});

	it("re-saving an unchanged file near the cap succeeds on the live route", async () => {
		const workspaceId = "single-ws-delta";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		// 2 x 900KB = 1.8MB of the 2MB test cap. Re-saving one unchanged is
		// net-zero and must succeed; the raw-length check 413'd it.
		const chunk = "q".repeat(900_000);
		for (const name of ["a.md", "b.md"]) {
			const push = await authedJson<{ ok: boolean }>("/api/files", {
				method: "POST",
				...jsonBody({
					workspaceId,
					path: name,
					contentHash: "h",
					content: chunk,
					deviceId: "d",
				}),
			});
			expect(push.body.ok).toBe(true);
		}

		const resave = await authedJson<{ ok: boolean }>("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "a.md",
				contentHash: "h",
				content: chunk,
				deviceId: "d",
			}),
		});
		expect(resave.body.ok).toBe(true);
	});

	it("asset push/delete canonicalise paths: traversal rejected, spellings stored canonically", async () => {
		const workspaceId = "asset-paths-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		const upload = await fetchWithBearer("/api/asset/upload", {
			method: "POST",
			body: new Uint8Array([9, 9, 9]),
		});
		const { storageId } = (await upload.json()) as { storageId: string };

		const pushAsset = (path: string) =>
			authedJson<{ ok: boolean; error: string; code: string }>("/api/assets", {
				method: "POST",
				...jsonBody({ workspaceId, path, storageId, deviceId: "d" }),
			});

		// Root escapes are rejected, never stored.
		for (const evil of ["../evil.png", "../../../etc/passwd"]) {
			const rejected = await pushAsset(evil);
			expect.soft(rejected.status, evil).toBe(400);
			expect.soft(rejected.body.code, evil).toBe("INVALID_PATH");
		}

		// Structural spelling collapses; anything else is stored
		// byte-for-byte, including the trailing space — a different file.
		expect((await pushAsset("./a.assets/x.png")).body.ok).toBe(true);
		expect((await pushAsset("a.assets/x.png ")).body.ok).toBe(true);

		const assets = await authedJson<{ assets: { path: string }[] }>(
			`/api/assets?workspaceId=${workspaceId}`,
		);
		expect(assets.body.assets.map((a) => a.path).sort()).toEqual([
			"a.assets/x.png",
			"a.assets/x.png ",
		]);

		// Delete by canonical spelling removes the row (asset listings
		// include deleted rows with a flag, unlike file listings).
		const del = await authedJson<{ ok: boolean }>("/api/assets/delete", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "a.assets/x.png",
				deviceId: "d",
			}),
		});
		expect(del.body.ok).toBe(true);
		const after = await authedJson<{
			assets: { path: string; deleted: boolean }[];
		}>(`/api/assets?workspaceId=${workspaceId}`);
		expect(after.body.assets).toHaveLength(2);
		expect(
			after.body.assets.find((a) => a.path === "a.assets/x.png")?.deleted,
		).toBe(true);
		expect(
			after.body.assets.find((a) => a.path === "a.assets/x.png ")?.deleted,
		).toBe(false);
	});

	it("control characters, zero-width/bidi marks, and over-long paths are rejected 400", async () => {
		const workspaceId = "poison-paths-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const cases: [string, string][] = [
			["nul.md\u0000", "NUL byte"],
			["zw.md\u200B", "zero-width space"],
			["bidi\u202B.md", "bidi override"],
			[`long/${"x".repeat(2000)}.md`, "over-long path"],
		];
		for (const [path, label] of cases) {
			const push = await authedJson<{ error: string; code: string }>(
				"/api/files",
				{
					method: "POST",
					...jsonBody({
						workspaceId,
						path,
						contentHash: "h",
						content: "x",
						deviceId: "d",
					}),
				},
			);
			expect.soft(push.status, label).toBe(400);
			expect.soft(push.body.code, label).toBe("INVALID_PATH");
		}

		const files = await authedJson<{ files: unknown[] }>(
			`/api/files?workspaceId=${workspaceId}&includeDeleted=true`,
		);
		expect(files.body.files).toHaveLength(0);
	});

	it("deleteFile removes legacy non-canonical rows by canonical or raw spelling", async () => {
		const workspaceId = "delete-fallback-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		const stub = workspaceDoStub(workspaceId);

		// Seed rows the way the pre-canonicalisation server stored them —
		// straight into storage, bypassing the canonicalising write path.
		await runInDurableObject(stub, (_instance, state) => {
			upsertFile(state.storage.sql, {
				path: "./legacy.md",
				contentHash: "h",
				content: "old",
				deviceId: "d",
			});
			upsertFile(state.storage.sql, {
				path: "trail.md ",
				contentHash: "h",
				content: "old",
				deviceId: "d",
			});
		});

		// The raw (legacy) spellings delete those rows: canonicalisation
		// finds no canonical row, so deleteFile falls back to the raw path.
		// Without the fallback these deletes match nothing and the rows stay.
		for (const name of ["./legacy.md", "trail.md "]) {
			const del = await authedJson<{ ok: boolean }>("/api/files/delete", {
				method: "POST",
				...jsonBody({ workspaceId, path: name, deviceId: "d" }),
			});
			expect(del.body.ok).toBe(true);
		}
		const gone = await authedJson<{ files: unknown[] }>(
			`/api/files?workspaceId=${workspaceId}`,
		);
		expect(gone.body.files).toHaveLength(0);

		// And the normal path is untouched: a canonical row deletes by its
		// canonical spelling.
		const pushed = await authedJson<{ ok: boolean }>("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "normal.md",
				contentHash: "h",
				content: "new",
				deviceId: "d",
			}),
		});
		expect(pushed.body.ok).toBe(true);
		const delNormal = await authedJson<{ ok: boolean }>("/api/files/delete", {
			method: "POST",
			...jsonBody({ workspaceId, path: "normal.md", deviceId: "d" }),
		});
		expect(delNormal.body.ok).toBe(true);
		const gone2 = await authedJson<{ files: unknown[] }>(
			`/api/files?workspaceId=${workspaceId}`,
		);
		expect(gone2.body.files).toHaveLength(0);
	});

	it("unknown errors map to a generic message, never the raw detail", () => {
		const result = toRpcError(new Error("s3cr3t-internals-xyz"));
		expect(result.ok).toBe(false);
		expect(result.code).toBe("UNKNOWN");
		expect(result.message).not.toContain("s3cr3t-internals-xyz");
	});
});

describe("round-4 fixes", () => {
	it("oversized fields on every write route get a clean 413, never the RPC leak", async () => {
		const workspaceId = "req-cap-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		const upload = await fetchWithBearer("/api/asset/upload", {
			method: "POST",
			body: new Uint8Array([7, 7, 7]),
		});
		const { storageId } = (await upload.json()) as { storageId: string };

		// Each field below serialises past the 32MiB RPC ceiling on its own;
		// without the pre-RPC total cap every one of these 500s leaking
		// "Serialized RPC arguments ..." verbatim.
		const huge = "q".repeat(33 * 1024 * 1024);
		const cases: { label: string; run: () => Promise<Response> }[] = [
			{
				label: "POST /api/files contentHash",
				run: () =>
					fetchWithBearer("/api/files", {
						method: "POST",
						...jsonBody({
							workspaceId,
							path: "a.md",
							contentHash: huge,
							content: "x",
							deviceId: "d",
						}),
					}),
			},
			{
				label: "POST /api/files/batch contentHash",
				run: () =>
					fetchWithBearer("/api/files/batch", {
						method: "POST",
						...jsonBody({
							workspaceId,
							files: [
								{
									path: "b.md",
									contentHash: huge,
									content: "x",
									deviceId: "d",
								},
							],
						}),
					}),
			},
			{
				label: "POST /api/files/delete path",
				run: () =>
					fetchWithBearer("/api/files/delete", {
						method: "POST",
						...jsonBody({ workspaceId, path: huge, deviceId: "d" }),
					}),
			},
			{
				label: "POST /api/assets path",
				run: () =>
					fetchWithBearer("/api/assets", {
						method: "POST",
						...jsonBody({ workspaceId, path: huge, storageId, deviceId: "d" }),
					}),
			},
			{
				label: "POST /api/assets/delete path",
				run: () =>
					fetchWithBearer("/api/assets/delete", {
						method: "POST",
						...jsonBody({ workspaceId, path: huge, deviceId: "d" }),
					}),
			},
		];
		for (const { label, run } of cases) {
			const response = await run();
			const body = (await response.json()) as { error: string; code: string };
			expect.soft(response.status, label).toBe(413);
			expect.soft(body.code, label).toBe("REQUEST_TOO_LARGE");
			expect.soft(JSON.stringify(body), label).not.toContain("Serialized RPC");
		}
	});

	it("errorToResponseBody keeps typed errors specific and generics generic", () => {
		const typed = errorToResponseBody(new StorageCapExceededError(3, 2));
		expect(typed.status).toBe(413);
		expect(typed.body.code).toBe("STORAGE_CAP_EXCEEDED");
		expect(typed.body.error).toContain("3");

		const generic = errorToResponseBody(new Error("boom-leak-xyz"));
		expect(generic.status).toBe(500);
		expect(JSON.stringify(generic.body)).not.toContain("boom-leak-xyz");
	});

	it("the slot invariant runs on deletes: a browser cannot delete the canonical log", async () => {
		const workspaceId = "del-invariant-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		await fetchWithBearer("/api/device/register", {
			method: "POST",
			...jsonBody({ workspaceId, deviceId: "browser-1" }),
		});

		// Canonical log owned by the desktop (unregistered writer — allowed).
		const created = await authedJson<{ ok: boolean }>("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: ".mdly/comments/note.jsonl",
				contentHash: "h",
				content: "[]",
				deviceId: "desktop-1",
			}),
		});
		expect(created.body.ok).toBe(true);

		// The browser that is 403'd from writing it is 403'd from deleting it.
		const del = await authedJson<{ error: string; code: string }>(
			"/api/files/delete",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					path: ".mdly/comments/note.jsonl",
					deviceId: "browser-1",
				}),
			},
		);
		expect(del.status).toBe(403);
		expect(del.body.code).toBe("SLOT_INVARIANT_VIOLATION");

		// Row still live.
		const files = await authedJson<{ files: { deleted: boolean }[] }>(
			`/api/files?workspaceId=${workspaceId}`,
		);
		expect(files.body.files).toHaveLength(1);
		expect(files.body.files[0]?.deleted).toBe(false);

		// Positive: the browser CAN delete its own suffixed log...
		const own = await authedJson<{ ok: boolean }>("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: ".mdly/comments/mine 2.jsonl",
				contentHash: "h",
				content: "[]",
				deviceId: "browser-1",
			}),
		});
		expect(own.body.ok).toBe(true);
		const ownDel = await authedJson<{ ok: boolean }>("/api/files/delete", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: ".mdly/comments/mine 2.jsonl",
				deviceId: "browser-1",
			}),
		});
		expect(ownDel.body.ok).toBe(true);

		// ...and the desktop owner CAN delete the canonical log.
		const ownerDel = await authedJson<{ ok: boolean }>("/api/files/delete", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: ".mdly/comments/note.jsonl",
				deviceId: "desktop-1",
			}),
		});
		expect(ownerDel.body.ok).toBe(true);
	});

	it("asset deletes fall back to the raw path for legacy rows", async () => {
		const workspaceId = "asset-fallback-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		const upload = await fetchWithBearer("/api/asset/upload", {
			method: "POST",
			body: new Uint8Array([5, 5, 5]),
		});
		const { storageId } = (await upload.json()) as { storageId: string };
		const stub = workspaceDoStub(workspaceId);

		// Legacy row as production holds it — creatable only by bypassing the
		// normalising write path; the DELETE under test goes via the route.
		await runInDurableObject(stub, (_instance, state) => {
			upsertAsset(state.storage.sql, {
				path: "./legacy.assets/a.png",
				hash: storageId,
				deviceId: "d",
			});
		});

		const del = await authedJson<{ ok: boolean }>("/api/assets/delete", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "./legacy.assets/a.png",
				deviceId: "d",
			}),
		});
		expect(del.body.ok).toBe(true);

		const assets = await authedJson<{ assets: { deleted: boolean }[] }>(
			`/api/assets?workspaceId=${workspaceId}`,
		);
		expect(assets.body.assets).toHaveLength(1);
		expect(assets.body.assets[0]?.deleted).toBe(true);
	});

	it("delete prefers the live raw row so no spelling is stranded", async () => {
		const workspaceId = "del-precedence-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		const stub = workspaceDoStub(workspaceId);

		// Both spellings live: deleting the raw spelling must remove the raw
		// row, not the canonical one.
		await runInDurableObject(stub, (_instance, state) => {
			upsertFile(state.storage.sql, {
				path: "./dup.md",
				contentHash: "h",
				content: "legacy",
				deviceId: "d",
			});
			upsertFile(state.storage.sql, {
				path: "dup.md",
				contentHash: "h",
				content: "canonical",
				deviceId: "d",
			});
		});
		const del = await authedJson<{ ok: boolean }>("/api/files/delete", {
			method: "POST",
			...jsonBody({ workspaceId, path: "./dup.md", deviceId: "d" }),
		});
		expect(del.body.ok).toBe(true);
		const after = await authedJson<{
			files: { path: string; deleted: boolean }[];
		}>(`/api/files?workspaceId=${workspaceId}&includeDeleted=true`);
		expect(after.body.files.find((f) => f.path === "./dup.md")?.deleted).toBe(
			true,
		);
		expect(after.body.files.find((f) => f.path === "dup.md")?.deleted).toBe(
			false,
		);

		// Dead canonical + live legacy: the live legacy row is still removed.
		await runInDurableObject(stub, (_instance, state) => {
			upsertFile(state.storage.sql, {
				path: "./dup2.md",
				contentHash: "h",
				content: "legacy",
				deviceId: "d",
			});
			upsertFile(state.storage.sql, {
				path: "dup2.md",
				contentHash: "h",
				content: "canonical",
				deviceId: "d",
			});
		});
		const killCanonical = await authedJson<{ ok: boolean }>(
			"/api/files/delete",
			{
				method: "POST",
				...jsonBody({ workspaceId, path: "dup2.md", deviceId: "d" }),
			},
		);
		expect(killCanonical.body.ok).toBe(true);
		const delRaw = await authedJson<{ ok: boolean }>("/api/files/delete", {
			method: "POST",
			...jsonBody({ workspaceId, path: "./dup2.md", deviceId: "d" }),
		});
		expect(delRaw.body.ok).toBe(true);
		const after2 = await authedJson<{
			files: { path: string; deleted: boolean }[];
		}>(`/api/files?workspaceId=${workspaceId}&includeDeleted=true`);
		expect(after2.body.files.find((f) => f.path === "./dup2.md")?.deleted).toBe(
			true,
		);
	});

	it("deviceIds with forbidden characters are rejected on write routes", async () => {
		const workspaceId = "device-id-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const badPush = await authedJson<{ error: string }>("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "a.md",
				contentHash: "h",
				content: "x",
				deviceId: "dev\u0000",
			}),
		});
		expect(badPush.status).toBe(400);
		expect(badPush.body.error).toContain("deviceId");

		const badReg = await authedJson<{ error: string }>("/api/device/register", {
			method: "POST",
			...jsonBody({ workspaceId, deviceId: "dev\u200B" }),
		});
		expect(badReg.status).toBe(400);
	});
});

describe("round-5 blocker 2 (server)", () => {
	it("a 2.5MB single push is a typed 413 with nothing stored, never an opaque 500", async () => {
		const workspaceId = "single-ws-toobig";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		// Over both the workspace cap and the SQLite per-value ceiling: the
		// quota binds first, typed — the important part is no 500, no leak,
		// no row, no unhandled rejection.
		const big = "x".repeat(2_500_000);
		const push = await authedJson<{ error: string; code: string }>(
			"/api/files",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					path: "big.md",
					contentHash: "h",
					content: big,
					deviceId: "d",
				}),
			},
		);
		expect(push.status).toBe(413);
		expect(push.body.code).toMatch(/STORAGE_CAP_EXCEEDED|FILE_TOO_LARGE/);
		expect(JSON.stringify(push.body)).not.toContain("Internal error");
		expect(JSON.stringify(push.body)).not.toContain("Serialized RPC");

		const files = await authedJson<{ files: unknown[] }>(
			`/api/files?workspaceId=${workspaceId}&includeDeleted=true`,
		);
		expect(files.body.files).toHaveLength(0);
	});

	it("re-pushing an over-limit file is FILE_TOO_LARGE once the quota passes", async () => {
		const workspaceId = "single-ws-filecap";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		const stub = workspaceDoStub(workspaceId);

		// Seed a 2.15MB row bypassing the caps (production already holds such
		// rows: under the SQLite ceiling but over the new 2MiB cap, written
		// before the cap existed); re-pushing it is net-zero, so the quota
		// passes and the physical per-file ceiling must fire.
		const big = "x".repeat(2_150_000);
		await runInDurableObject(stub, (_instance, state) => {
			upsertFile(state.storage.sql, {
				path: "huge.md",
				contentHash: "h",
				content: big,
				deviceId: "d",
			});
		});
		const push = await authedJson<{ error: string; code: string }>(
			"/api/files",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					path: "huge.md",
					contentHash: "h",
					content: big,
					deviceId: "d",
				}),
			},
		);
		expect(push.status).toBe(413);
		expect(push.body.code).toBe("FILE_TOO_LARGE");
		expect(push.body.error).toContain("huge.md");
	});

	it("the cap is byte-exact: emoji over 2MiB in UTF-8 trips it below 2M JS units", async () => {
		const workspaceId = "single-ws-emoji";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		// 600,000 JS string units but 2,400,000 UTF-8 bytes. A `.length`
		// check would pass this to SQLite and 500; the byte check 413s.
		const emoji = "📝".repeat(600_000);
		expect(emoji.length).toBeLessThan(2_000_000);
		const push = await authedJson<{ error: string; code: string }>(
			"/api/files",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					path: "emoji.md",
					contentHash: "h",
					content: emoji,
					deviceId: "d",
				}),
			},
		);
		expect(push.status).toBe(413);
		expect(push.body.code).toBe("FILE_TOO_LARGE");
	});

	it("a 1.9MB note still syncs fine under the lowered cap", async () => {
		const workspaceId = "single-ws-fits";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const push = await authedJson<{ ok: boolean }>("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "log.md",
				contentHash: "h",
				content: "x".repeat(1_900_000),
				deviceId: "d",
			}),
		});
		expect(push.body.ok).toBe(true);
	});

	it("a 3MiB entry via batch is a typed 413, not UNKNOWN", async () => {
		const workspaceId = "batch-ws-toobig";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const big = "x".repeat(3_145_728);
		const batch = await authedJson<{ error: string; code: string }>(
			"/api/files/batch",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					files: [
						{ path: "small.md", contentHash: "h", content: "x", deviceId: "d" },
						{ path: "big.md", contentHash: "h", content: big, deviceId: "d" },
					],
				}),
			},
		);
		expect(batch.status).toBe(413);
		expect(batch.body.code).toBe("FILE_TOO_LARGE");
		expect(JSON.stringify(batch.body)).not.toContain("Internal error");

		const files = await authedJson<{ files: unknown[] }>(
			`/api/files?workspaceId=${workspaceId}&includeDeleted=true`,
		);
		expect(files.body.files).toHaveLength(0);
	});

	it("a browser pushing an asset to the canonical log gets 403", async () => {
		const workspaceId = "asset-invariant-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		await fetchWithBearer("/api/device/register", {
			method: "POST",
			...jsonBody({ workspaceId, deviceId: "browser-1" }),
		});
		const upload = await fetchWithBearer("/api/asset/upload", {
			method: "POST",
			body: new Uint8Array([8, 8, 8]),
		});
		const { storageId } = (await upload.json()) as { storageId: string };

		const push = await authedJson<{ error: string; code: string }>(
			"/api/assets",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					path: ".mdly/comments/note.jsonl",
					storageId,
					deviceId: "browser-1",
				}),
			},
		);
		expect(push.status).toBe(403);
		expect(push.body.code).toBe("SLOT_INVARIANT_VIOLATION");

		// And the pre-existing delete path maps the same code to 403.
		const desktop = await authedJson<{ ok: boolean }>("/api/assets", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: ".mdly/comments/note.jsonl",
				storageId,
				deviceId: "desktop-1",
			}),
		});
		expect(desktop.body.ok).toBe(true);
		const del = await authedJson<{ error: string; code: string }>(
			"/api/assets/delete",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					path: ".mdly/comments/note.jsonl",
					deviceId: "browser-1",
				}),
			},
		);
		expect(del.status).toBe(403);
		expect(del.body.code).toBe("SLOT_INVARIANT_VIOLATION");
	});

	it("errorResponse wires typed errors specifically and generics generically", async () => {
		const { errorResponse } = await import("./index.js");
		const typed = errorResponse(new StorageCapExceededError(3, 2));
		expect(typed.status).toBe(413);
		const typedBody = (await typed.json()) as { code: string; error: string };
		expect(typedBody.code).toBe("STORAGE_CAP_EXCEEDED");

		const generic = errorResponse(new Error("wire-leak-xyz"));
		expect(generic.status).toBe(500);
		const genericBody = (await generic.json()) as { error: string };
		expect(genericBody.error).not.toContain("wire-leak-xyz");
	});
});

describe("round-6 pull paging (P0-2 server)", () => {
	it("a 10MB workspace pages through bounded responses and reassembles exactly", async () => {
		const workspaceId = "paging-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		const stub = workspaceDoStub(workspaceId);

		// 5 x 2MB rows (seeded direct: the 2MB test quota would 413 HTTP
		// pushes; the listing path under test is the real HTTP route).
		// Distinct updatedAt per row so cursor progress is observable.
		const chunk = "x".repeat(2_000_000);
		await runInDurableObject(stub, (_instance, state) => {
			for (let i = 0; i < 5; i++) {
				upsertFile(state.storage.sql, {
					path: `f-${i}.md`,
					contentHash: `h-${i}`,
					content: `${i}:${chunk.slice(2)}`,
					deviceId: "d",
				});
			}
		});

		const seen: { path: string; content: string }[] = [];
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
			const bodyBytes = JSON.stringify(res.body).length;
			// 8MB page budget: no response may approach the 32MiB ceiling.
			expect(bodyBytes).toBeLessThan(9 * 1024 * 1024);
			seen.push(...res.body.files);
			cursor = res.body.nextCursor;
			pages++;
			expect(pages).toBeLessThan(10);
		} while (cursor);

		// More than one page, everything reassembled exactly once.
		expect(pages).toBeGreaterThan(1);
		expect(seen.map((f) => f.path).sort()).toEqual([
			"f-0.md",
			"f-1.md",
			"f-2.md",
			"f-3.md",
			"f-4.md",
		]);
		for (let i = 0; i < 5; i++) {
			expect(seen.find((f) => f.path === `f-${i}.md`)?.content).toBe(
				`${i}:${chunk.slice(2)}`,
			);
		}
	});

	it("a malformed cursor is a clean 400, never a DO throw", async () => {
		const workspaceId = "paging-bad-cursor-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		for (const query of [
			"cursorUpdatedAt=abc",
			"cursorUpdatedAt=123",
			"cursorPath=x.md",
		]) {
			const res = await authedJson(
				`/api/files?workspaceId=${workspaceId}&${query}`,
			);
			expect(res.status, query).toBe(400);
		}
	});

	it("control-heavy notes page one per response and stay far under the ceiling", async () => {
		// M1: U+0001 escapes to 6 bytes in JSON, so 2MiB of it is ~12MB on
		// the wire. A raw-byte budget packs 4 such rows (~50MB wire) while an
		// escape-exact budget isolates them one per page (~12MB each).
		const workspaceId = "paging-controls-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		const stub = workspaceDoStub(workspaceId);
		// 2MiB of U+0001 (explicit escape: no invisible characters in source).
		const CTRL = "\u0001";
		const controls = `x${CTRL.repeat(2 * 1024 * 1024 - 1)}`;
		await runInDurableObject(stub, (_instance, state) => {
			for (let i = 0; i < 4; i++) {
				upsertFile(state.storage.sql, {
					path: `k-${i}.md`,
					contentHash: `h-${i}`,
					content: `${i}:${controls.slice(2)}`,
					deviceId: "d",
				});
			}
		});

		const seen = new Set<string>();
		let cursor: { updatedAt: number; path: string } | null = null;
		let pages = 0;
		let biggest = 0;
		do {
			const params = new URLSearchParams({ workspaceId });
			if (cursor) {
				params.set("cursorUpdatedAt", String(cursor.updatedAt));
				params.set("cursorPath", cursor.path);
			}
			const res = await authedJson<{
				files: { path: string }[];
				nextCursor: { updatedAt: number; path: string } | null;
			}>(`/api/files?${params.toString()}`);
			expect(res.status).toBe(200);
			const bodyBytes = new TextEncoder().encode(
				JSON.stringify(res.body),
			).length;
			biggest = Math.max(biggest, bodyBytes);
			// One 2MiB-control row escapes to ~12MB: bounded, and less than
			// half the 32MiB ceiling even in the adversarial case.
			expect(bodyBytes).toBeLessThan(16 * 1024 * 1024);
			for (const f of res.body.files) seen.add(f.path);
			cursor = res.body.nextCursor;
			pages++;
			expect(pages).toBeLessThan(10);
		} while (cursor);
		expect(seen.size).toBe(4);
		expect(pages).toBeGreaterThan(1);
	});

	it("a malformed asset path segment reaching the router is a generic 500", async () => {
		// /api/asset/% throws URIError in decodeURIComponent inside the
		// router, past auth — exercising errorResponse itself (not the
		// mapping function). Must be generic: the raw message would leak
		// router internals the same way the RPC text once did.
		const res = await fetchWithBearer("/api/asset/%");
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).not.toContain("URI");
		expect(body.error).toBe("Internal error.");
	});
});

describe("round-6 L7/L8 scalar field caps", () => {
	it("oversized contentHash/deviceId on /api/files are typed 413s", async () => {
		const workspaceId = "fields-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const huge = "h".repeat(3 * 1024 * 1024);
		for (const [label, extra] of [
			["contentHash", { contentHash: huge, deviceId: "d" }],
			["deviceId", { contentHash: "h", deviceId: huge }],
		] as const) {
			const push = await authedJson<{ error: string; code: string }>(
				"/api/files",
				{
					method: "POST",
					...jsonBody({
						workspaceId,
						path: "a.md",
						content: "x",
						...extra,
					}),
				},
			);
			expect(push.status, label).toBe(413);
			expect(push.body.code, label).toBe("FIELD_TOO_LARGE");
			expect(push.body.error, label).toContain(label);
		}

		const batch = await authedJson<{ error: string; code: string }>(
			"/api/files/batch",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					files: [
						{ path: "b.md", contentHash: huge, content: "x", deviceId: "d" },
					],
				}),
			},
		);
		expect(batch.status).toBe(413);
		expect(batch.body.code).toBe("FIELD_TOO_LARGE");
	});

	it("an oversized storageId on /api/assets is a typed 413, not an escaping R2 500", async () => {
		const workspaceId = "fields-assets-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const push = await authedJson<{ error: string; code: string }>(
			"/api/assets",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					path: "a.png",
					storageId: "s".repeat(3 * 1024 * 1024),
					deviceId: "d",
				}),
			},
		);
		expect(push.status).toBe(413);
		expect(push.body.code).toBe("FIELD_TOO_LARGE");
		expect(push.body.error).toContain("storageId");
	});

	it("an oversized deviceId on register is a typed 413 via route and via direct RPC", async () => {
		const workspaceId = "fields-register-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const hugeDevice = "d".repeat(3 * 1024 * 1024);
		const route = await authedJson<{ error: string; code: string }>(
			"/api/device/register",
			{
				method: "POST",
				...jsonBody({ workspaceId, deviceId: hugeDevice }),
			},
		);
		expect(route.status).toBe(413);
		expect(route.body.code).toBe("FIELD_TOO_LARGE");

		// Direct RPC: a typed result, never a SQLITE_TOOBIG throw escaping
		// the DO's error mapping.
		const stub = workspaceDoStub(workspaceId);
		const direct = await stub.registerDeviceSlot(hugeDevice);
		expect(direct.ok).toBe(false);
		if (!direct.ok) {
			expect(direct.code).toBe("FIELD_TOO_LARGE");
		}
	});
});

describe("round-7 byte-exact page budget (B2)", () => {
	it("20 emoji notes with max-length paths page bounded responses with no 500", async () => {
		const workspaceId = "paging-emoji-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		const stub = workspaceDoStub(workspaceId);

		// 524,288 emoji x 4 bytes = exactly 2MiB per note (at, not over, the
		// file cap), 1000-char paths. A character-counting budget admits all
		// 20 rows (~42MB) in a few responses and 500s; a byte budget pages
		// ~3 rows at a time. Seeded direct (quota bypass for setup); every
		// byte asserted below crosses the real HTTP route.
		// 📝 is one code point but two UTF-16 units and four UTF-8 bytes:
		// 524,288 of them are 1M JS units but exactly 2MiB on the wire.
		const emoji = "📝".repeat(524_288);
		expect(emoji.length).toBe(1_048_576);
		await runInDurableObject(stub, (_instance, state) => {
			for (let i = 0; i < 20; i++) {
				upsertFile(state.storage.sql, {
					path: `${`p-${i}-`.padEnd(996, "x")}.md`,
					contentHash: `h-${i}`,
					content: `${i}:${emoji.slice(2)}`,
					deviceId: "d",
				});
			}
		});

		const seen = new Set<string>();
		let cursor: { updatedAt: number; path: string } | null = null;
		let pages = 0;
		let biggest = 0;
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
			// UTF-8 bytes on the wire (JS `.length` counts UTF-16 units —
			// half the bytes for emoji — so measure properly).
			const bodyBytes = new TextEncoder().encode(
				JSON.stringify(res.body),
			).length;
			biggest = Math.max(biggest, bodyBytes);
			// 8MB budget + one max row: nowhere near the 32MiB ceiling.
			expect(bodyBytes).toBeLessThan(11 * 1024 * 1024);
			for (const f of res.body.files) seen.add(f.path);
			cursor = res.body.nextCursor;
			pages++;
			// Hang guard only: >256KiB rows are charged the conservative 6x
			// (exact quoting would itself overflow SQLite values), so 2MiB
			// rows legitimately page one per response here.
			expect(pages).toBeLessThan(100);
		} while (cursor);

		expect(pages).toBeGreaterThan(1);
		expect(seen.size).toBe(20);
		// Biggest single response stays near one max row: over-2MiB rows
		// are charged conservatively, so pages hold one row each here.
		expect(biggest).toBeGreaterThan(2 * 1024 * 1024);
	});
});

describe("round-7 M1/L2/L4", () => {
	it("an oversized label on register is a typed 413 via route and via direct RPC", async () => {
		const workspaceId = "fields-label-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const hugeLabel = "l".repeat(3 * 1024 * 1024);
		const route = await authedJson<{ error: string; code: string }>(
			"/api/device/register",
			{
				method: "POST",
				...jsonBody({ workspaceId, deviceId: "d", label: hugeLabel }),
			},
		);
		expect(route.status).toBe(413);
		expect(route.body.code).toBe("FIELD_TOO_LARGE");
		expect(route.body.error).toContain("label");

		// Direct RPC: a typed result, never a SQLITE_TOOBIG throw escaping
		// the DO's error mapping (the L7 unhandled rejection).
		const stub = workspaceDoStub(workspaceId);
		const direct = await stub.registerDeviceSlot("d", hugeLabel);
		expect(direct.ok).toBe(false);
		if (!direct.ok) {
			expect(direct.code).toBe("FIELD_TOO_LARGE");
		}

		// A normal label still registers.
		const ok = await authedJson<{ slot: number }>("/api/device/register", {
			method: "POST",
			...jsonBody({ workspaceId, deviceId: "d", label: "MacBook" }),
		});
		expect(ok.body.slot).toBe(2);
	});

	it("a non-string label is a clean 400", async () => {
		const workspaceId = "fields-label-type-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const res = await authedJson("/api/device/register", {
			method: "POST",
			...jsonBody({ workspaceId, deviceId: "d", label: ["x"] }),
		});
		expect(res.status).toBe(400);
	});

	it("a malformed since is a clean 400 on both listings", async () => {
		const workspaceId = "bad-since-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		for (const route of [
			`/api/files?workspaceId=${workspaceId}&since=abc`,
			`/api/assets?workspaceId=${workspaceId}&since=abc`,
		]) {
			const res = await authedJson<{ files?: unknown[]; assets?: unknown[] }>(
				route,
			);
			expect(res.status, route).toBe(400);
		}

		// A valid since still filters.
		const push = await authedJson<{ ok: boolean }>("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "n.md",
				contentHash: "h",
				content: "hi",
				deviceId: "d",
			}),
		});
		expect(push.body.ok).toBe(true);
		const list = await authedJson<{ files: unknown[] }>(
			`/api/files?workspaceId=${workspaceId}&since=0`,
		);
		expect(list.body.files).toHaveLength(1);
		const future = await authedJson<{ files: unknown[] }>(
			`/api/files?workspaceId=${workspaceId}&since=${Date.now() + 100000}`,
		);
		expect(future.body.files).toHaveLength(0);
	});

	it("the GC asset scan pages and reassembles", async () => {
		const workspaceId = "gc-paging-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		const stub = workspaceDoStub(workspaceId);

		for (let i = 0; i < 5; i++) {
			const upload = await fetchWithBearer("/api/asset/upload", {
				method: "POST",
				body: new Uint8Array([100 + i]),
			});
			const { storageId } = (await upload.json()) as { storageId: string };
			const pushed = await authedJson<{ ok: boolean }>("/api/assets", {
				method: "POST",
				...jsonBody({
					workspaceId,
					path: `p${i}.assets/a.png`,
					storageId,
					deviceId: "d",
				}),
			});
			expect(pushed.body.ok).toBe(true);
		}

		// Tiny budget forces multiple pages through the real DO method.
		const seen: string[] = [];
		let cursor: { path: string } | null = null;
		let pages = 0;
		do {
			const page = await stub.listAssetsForGc({ cursor, maxBytes: 300 });
			seen.push(...page.assets.map((a) => a.path));
			cursor = page.nextCursor;
			pages++;
			expect(pages).toBeLessThan(10);
		} while (cursor);
		expect(pages).toBeGreaterThan(1);
		expect(seen.sort()).toEqual([
			"p0.assets/a.png",
			"p1.assets/a.png",
			"p2.assets/a.png",
			"p3.assets/a.png",
			"p4.assets/a.png",
		]);
	});
});
