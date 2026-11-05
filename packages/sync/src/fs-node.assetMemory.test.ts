import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contentHash } from "./fs.js";
import {
	ASSET_READ_CONCURRENCY,
	ASSET_STREAM_THRESHOLD,
	createNodeFileSystem,
	hashFileStream,
	readInOrder,
} from "./fs-node.js";

// Assets can be up to MAX_ASSET_SIZE each; buffering 32 at once would peak
// at ~32x that. Assets keep only their hash, so big ones stream through
// SHA-256 and fewer run at once.
describe("asset snapshot memory bounds", () => {
	it("readInOrder never exceeds the given concurrency", async () => {
		let inFlight = 0;
		let peak = 0;
		const paths = Array.from({ length: 40 }, (_, i) => `p${i}`);
		const out = await readInOrder(
			paths,
			async (p) => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await new Promise((r) => setTimeout(r, 1));
				inFlight--;
				return p;
			},
			ASSET_READ_CONCURRENCY,
		);
		expect(out).toEqual(paths);
		expect(peak).toBe(ASSET_READ_CONCURRENCY);
		expect(ASSET_READ_CONCURRENCY).toBeLessThanOrEqual(4);
	});

	it("streamed hash is byte-identical to Web Crypto contentHash", async () => {
		const dir = mkdtempSync(join(tmpdir(), "asset-stream-"));
		try {
			for (const size of [0, 1, 65_537, ASSET_STREAM_THRESHOLD + 13]) {
				const data = new Uint8Array(randomBytes(size));
				const file = join(dir, `f${size}`);
				writeFileSync(file, data);
				expect(await hashFileStream(file)).toBe(await contentHash(data));
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stream errors keep code/path (ENOENT skip, others rethrown)", async () => {
		const missing = join(tmpdir(), "definitely-missing-asset-xyz");
		await expect(hashFileStream(missing)).rejects.toMatchObject({
			code: "ENOENT",
			path: missing,
		});
	});

	it("large assets via listAssetFiles hash identically", async () => {
		const dir = mkdtempSync(join(tmpdir(), "asset-big-"));
		try {
			mkdirSync(join(dir, "n.assets"));
			writeFileSync(join(dir, "n.md"), "x");
			const big = new Uint8Array(randomBytes(ASSET_STREAM_THRESHOLD + 5));
			const small = new Uint8Array(randomBytes(100));
			writeFileSync(join(dir, "n.assets", "big.png"), big);
			writeFileSync(join(dir, "n.assets", "small.png"), small);
			const assets = await createNodeFileSystem().listAssetFiles(dir);
			expect(assets.map((a) => [a.relativePath, a.hash, a.size])).toEqual([
				["n.assets/big.png", await contentHash(big), big.length],
				["n.assets/small.png", await contentHash(small), small.length],
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
