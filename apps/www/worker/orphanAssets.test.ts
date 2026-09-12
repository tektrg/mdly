import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runOrphanAssetCleanup } from "./cron.js";
import { upsertAsset } from "./durableObject/assets.js";
import { orphanAssetCandidates } from "./orphanAssets.js";
import { fetchWithBearer, jsonBody, workspaceDoStub } from "./testHelpers.js";

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

	/**
	 * Round-5 blocker 1: reachability must not depend on folder naming. The
	 * writer accepts any path and the desktop uploads images from anywhere,
	 * so an image in a plain folder referenced by a live note must survive a
	 * FULL cron cycle including the grace period — while a genuinely
	 * unreferenced asset is still collected. All rows created through the
	 * real routes; the real `runOrphanAssetCleanup` drives both cycles.
	 */
	it("referenced images outside .assets folders survive the full GC cycle; true orphans are still collected", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));

		const workspaceId = "orphan-gc-plain";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		const hashes: Record<string, string> = {};
		for (const [key, byte] of [
			["nested", 21],
			["root", 22],
			["deep", 23],
			["hash", 24],
			["query", 25],
			["orphan", 26],
		] as const) {
			hashes[key] = await uploadBytes(byte);
		}

		const pushAsset = (path: string, storageId: string) =>
			fetchWithBearer("/api/assets", {
				method: "POST",
				...jsonBody({ workspaceId, path, storageId, deviceId: "d" }),
			});
		for (const [path, key] of [
			["images/logo.png", "nested"],
			["logo.png", "root"],
			["docs/img/a.png", "deep"],
			["pics/a#b.png", "hash"],
			["pics/c?d.png", "query"],
			["images/orphan.png", "orphan"],
		] as const) {
			const pushed = await pushAsset(path, hashes[key] as string);
			expect(pushed.status, path).toBe(200);
		}

		await fetchWithBearer("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "note.md",
				contentHash: "h",
				content: [
					"![logo](images/logo.png)",
					"![root](logo.png)",
					"![deep](docs/img/a.png)",
					"![hash](pics/a%23b.png)",
					"![angle](<pics/a#b.png>)",
					"![query](pics/c%3Fd.png)",
				].join("\n"),
				deviceId: "d",
			}),
		});
		// Relative resolution from a nested note, too.
		await fetchWithBearer("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "docs/note2.md",
				contentHash: "h2",
				content: "![deep](img/a.png)",
				deviceId: "d",
			}),
		});

		// First cycle: only the true orphan is marked.
		const firstRun = await runOrphanAssetCleanup(env);
		expect(firstRun.marked).toBe(1);
		expect(firstRun.rowsDeleted).toBe(0);
		expect(firstRun.r2ObjectsDeleted).toBe(0);

		// Past the grace period: the orphan is collected, everything
		// referenced is untouched and still downloadable.
		vi.setSystemTime(new Date("2026-06-09T00:00:00Z"));
		const secondRun = await runOrphanAssetCleanup(env);
		expect(secondRun.rowsDeleted).toBe(1);
		expect(secondRun.r2ObjectsDeleted).toBe(1);

		for (const key of ["nested", "root", "deep", "hash", "query"]) {
			const download = await fetchWithBearer(`/api/asset/${hashes[key]}`);
			expect(download.status, key).toBe(200);
		}
		const orphanGone = await fetchWithBearer(`/api/asset/${hashes.orphan}`);
		expect(orphanGone.status).toBe(404);
	});

	/**
	 * Round-5 blocker 1, item 3: production already flagged referenced rows
	 * (cron ran 2026-09-02/03 with the old predicate). A marked asset that is
	 * referenced under the fixed predicate is restored to unmarked on the
	 * next scan — all through the real routes.
	 */
	it("a marked-then-referenced asset outside .assets is restored to unmarked", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));

		const workspaceId = "orphan-gc-unmark";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		const hash = await uploadBytes(31);
		await fetchWithBearer("/api/assets", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "images/late.png",
				storageId: hash,
				deviceId: "d",
			}),
		});

		// No note yet: correctly marked as unreferenced.
		const firstRun = await runOrphanAssetCleanup(env);
		expect(firstRun.marked).toBe(1);

		// The reference appears before the grace period elapses.
		await fetchWithBearer("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "note.md",
				contentHash: "h",
				content: "![late](images/late.png)",
				deviceId: "d",
			}),
		});
		const secondRun = await runOrphanAssetCleanup(env);
		expect(secondRun.restored).toBe(1);
		expect(secondRun.rowsDeleted).toBe(0);

		// Past the grace period: still alive, because the mark was cleared.
		vi.setSystemTime(new Date("2026-06-09T00:00:00Z"));
		const thirdRun = await runOrphanAssetCleanup(env);
		expect(thirdRun.rowsDeleted).toBe(0);
		expect(thirdRun.r2ObjectsDeleted).toBe(0);
		const download = await fetchWithBearer(`/api/asset/${hash}`);
		expect(download.status).toBe(200);
	});
});

describe("round-6 containment matcher (P0-1)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("every reference syntax survives the full GC cycle; legacy rows match; true orphans are still collected", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));

		const workspaceId = "gc-syntax-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		// Distinct bytes per asset so R2 refcounts stay unambiguous.
		const paths = [
			"images/inline.png",
			"images/ref.png",
			"images/logo.png",
			"images/short.png",
			"images/tag.png",
			"images/link.png",
			"pics/a#b.png",
			"pics/c?d.png",
			"images/prose.png",
			"images/code.png",
			"images/z.png",
			"images/orphan.png",
		] as const;
		const hashes: Record<string, string> = {};
		let byte = 41;
		for (const path of paths) {
			hashes[path] = await uploadBytes(byte++);
		}
		for (const path of paths) {
			const pushed = await fetchWithBearer("/api/assets", {
				method: "POST",
				...jsonBody({
					workspaceId,
					path,
					storageId: hashes[path],
					deviceId: "d",
				}),
			});
			expect(pushed.status, path).toBe(200);
		}

		// Legacy non-canonical rows as production holds them — creatable only
		// by bypassing the normalising write path; everything asserted below
		// goes through the real cron.
		const stub = workspaceDoStub(workspaceId);
		const legacyX = await uploadBytes(60);
		const legacyY = await uploadBytes(61);
		await runInDurableObject(stub, (_instance, state) => {
			upsertAsset(state.storage.sql, {
				path: "./images/x.png",
				hash: legacyX,
				deviceId: "d",
			});
			upsertAsset(state.storage.sql, {
				path: "images//y.png",
				hash: legacyY,
				deviceId: "d",
			});
		});

		await fetchWithBearer("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "note.md",
				contentHash: "h",
				content: [
					"![inline](images/inline.png)",
					"![ref][rid]",
					"",
					"[rid]: images/ref.png",
					"![images/logo.png][]",
					"![images/short.png]",
					'<img src="images/tag.png">',
					'<a href="images/link.png">pic</a>',
					"![hash](pics/a%23b.png)",
					"![angle](<pics/a#b.png>)",
					"![query](pics/c%3Fd.png)",
					"The file images/prose.png is discussed here in prose.",
					"```",
					"![code](images/code.png)",
					"```",
					"![x](images/x.png)",
					"![y](images/y.png)",
					"![z](images/z.png)",
				].join("\n"),
				deviceId: "d",
			}),
		});

		// First cycle: only the true orphan is marked.
		const firstRun = await runOrphanAssetCleanup(env);
		expect(firstRun.marked).toBe(1);
		expect(firstRun.rowsDeleted).toBe(0);
		expect(firstRun.r2ObjectsDeleted).toBe(0);

		// Past the grace period: the orphan is collected, all thirteen
		// referenced assets — every syntax plus both legacy spellings —
		// are untouched and still downloadable.
		vi.setSystemTime(new Date("2026-07-09T00:00:00Z"));
		const secondRun = await runOrphanAssetCleanup(env);
		expect(secondRun.rowsDeleted).toBe(1);
		expect(secondRun.r2ObjectsDeleted).toBe(1);

		for (const path of paths) {
			if (path === "images/orphan.png") continue;
			const download = await fetchWithBearer(`/api/asset/${hashes[path]}`);
			expect(download.status, path).toBe(200);
		}
		for (const hash of [legacyX, legacyY]) {
			const download = await fetchWithBearer(`/api/asset/${hash}`);
			expect(download.status, hash).toBe(200);
		}
		const orphanGone = await fetchWithBearer(
			`/api/asset/${hashes["images/orphan.png"]}`,
		);
		expect(orphanGone.status).toBe(404);
	});
});

describe("round-7 resolution (B1)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("nested-note relative refs, case differences and NFC/NFD all survive the full GC cycle", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));

		const workspaceId = "gc-resolve-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		let nextByte = 70;
		const upload = async () => {
			nextByte += 1;
			return uploadBytes(nextByte);
		};

		// The product's own default image folder, referenced from a nested
		// note exactly the way the desktop writes it.
		const pic = await upload();
		// Case-insensitive match target.
		const logo = await upload();
		// Stored NFD (macOS disk form); referenced NFC (editor form).
		const cafe = await upload();
		// Two directories deep, ./ and ../ relative forms.
		const deepA = await upload();
		const deepB = await upload();
		// Legacy non-canonical row resolved relatively.
		const legacyL = await upload();
		// Space left raw while # is encoded (hand-written form matching
		// neither the raw nor the fully-encoded spelling).
		const partial = await upload();
		// Reference-style + img-tag syntax composed with resolution.
		const ref2 = await upload();
		const tag2 = await upload();
		// Genuinely unreferenced: must still be collected.
		const orphan = await upload();

		const pushAsset = (path: string, storageId: string) =>
			fetchWithBearer("/api/assets", {
				method: "POST",
				...jsonBody({ workspaceId, path, storageId, deviceId: "d" }),
			});
		const stored: [string, string][] = [
			["docs/note.assets/pic.png", pic],
			["images/logo.png", logo],
			["images/cafe\u0301.png", cafe],
			["a/b/x.assets/a.png", deepA],
			["a/sibling.assets/b.png", deepB],
			["images/ref2.png", ref2],
			["images/tag2.png", tag2],
			["sp ace/a#b.png", partial],
			["images/orphan7.png", orphan],
		];
		for (const [path, hash] of stored) {
			const pushed = await pushAsset(path, hash);
			expect(pushed.status, path).toBe(200);
		}
		// Legacy row only creatable by bypassing the normalising writer.
		const stub = workspaceDoStub(workspaceId);
		await runInDurableObject(stub, (_instance, state) => {
			upsertAsset(state.storage.sql, {
				path: "./docs/old.assets/l.png",
				hash: legacyL,
				deviceId: "d",
			});
		});

		const pushNote = (path: string, content: string) =>
			fetchWithBearer("/api/files", {
				method: "POST",
				...jsonBody({
					workspaceId,
					path,
					contentHash: "h",
					content,
					deviceId: "d",
				}),
			});
		await pushNote("docs/note.md", "![pic](note.assets/pic.png)");
		await pushNote(
			"case.md",
			[
				"![logo](Images/Logo.PNG)",
				"![cafe](images/caf\u00e9.png)",
				"![partial](sp ace/a%23b.png)",
			].join("\n"),
		);
		await pushNote(
			"a/b/note.md",
			"![a](./x.assets/a.png)\n![b](../sibling.assets/b.png)",
		);
		await pushNote("docs/n2.md", "![r][i]\n\n[i]: old.assets/l.png");
		await pushNote(
			"mix.md",
			["![images/ref2.png][]", '<img src="images/tag2.png">'].join("\n"),
		);

		// First cycle: only the true orphan is marked.
		const firstRun = await runOrphanAssetCleanup(env);
		expect(firstRun.marked).toBe(1);
		expect(firstRun.rowsDeleted).toBe(0);

		// Past the grace period: the orphan is collected, everything else —
		// nested-relative, case-folded, NFC/NFD, legacy — still downloadable.
		vi.setSystemTime(new Date("2026-08-09T00:00:00Z"));
		const secondRun = await runOrphanAssetCleanup(env);
		expect(secondRun.rowsDeleted).toBe(1);
		expect(secondRun.r2ObjectsDeleted).toBe(1);

		for (const hash of [
			pic,
			logo,
			cafe,
			deepA,
			deepB,
			legacyL,
			ref2,
			tag2,
			partial,
		]) {
			const download = await fetchWithBearer(`/api/asset/${hash}`);
			expect(download.status, hash).toBe(200);
		}
		const orphanGone = await fetchWithBearer(`/api/asset/${orphan}`);
		expect(orphanGone.status).toBe(404);
	});
});

describe("round-8 NFD/encoding matrix (B2)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("all four stored/reference normalisation combinations survive the full GC cycle", async () => {
		// Distinct filenames per case: cases sharing one normalised path
		// would cover for each other inside a shared note, hiding a miss.
		// Each case gets its own note so a miss deletes exactly that asset.
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));

		const workspaceId = "gc-nfd-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		let nextByte = 90;
		const upload = async () => {
			nextByte += 1;
			return uploadBytes(nextByte);
		};

		// [stored path, note file, note reference, label]. NFD = e + U+0301
		// (macOS disk form), NFC = U+00E9 (editor form).
		const cases: [string, string, string, string][] = [
			[
				"images/n1-cafe\u0301.png",
				"n1.md",
				"images/n1-caf\u00e9.png",
				"nfd-stored-raw-ref",
			],
			[
				"images/n2-cafe\u0301.png",
				"n2.md",
				"images/n2-caf%C3%A9.png",
				"nfd-stored-encoded-ref",
			],
			[
				"images/n3-caf\u00e9.png",
				"n3.md",
				"images/n3-caf\u00e9.png",
				"nfc-stored-raw-ref",
			],
			[
				"images/n4-caf\u00e9.png",
				"n4.md",
				"images/n4-caf%C3%A9.png",
				"nfc-stored-encoded-ref",
			],
		];
		const hashes: Record<string, string> = {};
		for (const [, , , label] of cases) {
			hashes[label] = await upload();
		}
		const orphan = await upload();
		for (const [stored, , , label] of cases) {
			const pushed = await fetchWithBearer("/api/assets", {
				method: "POST",
				...jsonBody({
					workspaceId,
					path: stored,
					storageId: hashes[label],
					deviceId: "d",
				}),
			});
			expect(pushed.status, label).toBe(200);
		}
		await fetchWithBearer("/api/assets", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "images/orphan8.png",
				storageId: orphan,
				deviceId: "d",
			}),
		});
		for (const [, note, ref] of cases) {
			await fetchWithBearer("/api/files", {
				method: "POST",
				...jsonBody({
					workspaceId,
					path: note,
					contentHash: "h",
					content: `![x](${ref})`,
					deviceId: "d",
				}),
			});
		}

		const firstRun = await runOrphanAssetCleanup(env);
		expect(firstRun.marked).toBe(1);
		expect(firstRun.rowsDeleted).toBe(0);

		vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
		const secondRun = await runOrphanAssetCleanup(env);
		expect(secondRun.rowsDeleted).toBe(1);
		expect(secondRun.r2ObjectsDeleted).toBe(1);

		for (const [, , , label] of cases) {
			const download = await fetchWithBearer(`/api/asset/${hashes[label]}`);
			expect(download.status, label).toBe(200);
		}
		const orphanGone = await fetchWithBearer(`/api/asset/${orphan}`);
		expect(orphanGone.status).toBe(404);
	});
});
