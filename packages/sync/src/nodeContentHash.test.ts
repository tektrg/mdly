import { randomBytes } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contentHash } from "./fs.js";
import { createNodeFileSystem, nodeContentHash } from "./fs-node.js";

// The server stores and compares these hashes and assets are content-
// addressed by them: the node:crypto path must be byte-identical to the
// Web Crypto `contentHash` for every input.
describe("nodeContentHash matches Web Crypto contentHash", () => {
	const strings = [
		"",
		"hello",
		"# Heading\n\nbody with ünïcödé, emoji 🚀, CJK 漢字\r\n",
		"lone surrogate \ud800 and \udfff end",
		"x".repeat(1 << 20),
	];
	it.each(
		strings.map((s) => [s.slice(0, 24), s]),
	)("string %j", async (_label, input) => {
		expect(nodeContentHash(input)).toBe(await contentHash(input));
	});

	const bytes: Uint8Array[] = [
		new Uint8Array(0),
		new Uint8Array([0]),
		new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0xc3]),
		new Uint8Array(randomBytes(4096)),
		new Uint8Array(randomBytes(3 * 1024 * 1024 + 7)),
	];
	it.each(
		bytes.map((b, i) => [i, b.length, b]),
	)("bytes #%i (%i bytes)", async (_i, _len, input) => {
		const expected = await contentHash(input);
		expect(nodeContentHash(input)).toBe(expected);
		expect(nodeContentHash(Buffer.from(input))).toBe(expected);
		expect(expected).toMatch(/^[0-9a-f]{64}$/);
	});

	it("known vector: empty string", () => {
		expect(nodeContentHash("")).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});

	it("snapshot hashes equal Web Crypto over the real read path", async () => {
		const dir = mkdtempSync(join(tmpdir(), "node-hash-"));
		try {
			const note = "# n\n\nünïcödé 🚀\n";
			const asset = new Uint8Array(randomBytes(2048));
			writeFileSync(join(dir, "n.md"), note);
			const assetsDir = join(dir, "n.assets");
			mkdirSync(assetsDir);
			writeFileSync(join(assetsDir, "a.png"), asset);
			const fsys = createNodeFileSystem();
			const [notes, assets] = await Promise.all([
				fsys.listMarkdownFiles(dir),
				fsys.listAssetFiles(dir),
			]);
			expect(notes).toEqual([
				expect.objectContaining({
					relativePath: "n.md",
					content: note,
					hash: await contentHash(note),
				}),
			]);
			expect(assets).toEqual([
				expect.objectContaining({
					relativePath: "n.assets/a.png",
					hash: await contentHash(asset),
				}),
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("concurrent snapshot reads keep serial-loop semantics", () => {
	it("returns notes in walker order", async () => {
		const dir = mkdtempSync(join(tmpdir(), "snap-order-"));
		try {
			const expected: string[] = [];
			for (let d = 0; d < 6; d++) {
				mkdirSync(join(dir, `d${d}`));
				for (let f = 0; f < 30; f++) {
					writeFileSync(join(dir, `d${d}`, `f${f}.md`), `${d}-${f}`);
				}
			}
			const { notesWalker } = await import("@mdly/workspace-scan");
			expected.push(...(await notesWalker(dir)).files);
			const notes = await createNodeFileSystem().listMarkdownFiles(dir);
			expect(notes.map((n) => n.relativePath)).toEqual(expected);
			for (const n of notes) expect(n.hash).toBe(nodeContentHash(n.content));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rethrows the EARLIEST non-ENOENT read error in walk order", async () => {
		if (process.getuid?.() === 0) return;
		const dir = mkdtempSync(join(tmpdir(), "snap-err-"));
		try {
			for (const name of ["a.md", "b.md", "c.md", "d.md"]) {
				writeFileSync(join(dir, name), name);
			}
			chmodSync(join(dir, "b.md"), 0o000);
			chmodSync(join(dir, "d.md"), 0o000);
			await expect(
				createNodeFileSystem().listMarkdownFiles(dir),
			).rejects.toMatchObject({ code: "EACCES", path: join(dir, "b.md") });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
