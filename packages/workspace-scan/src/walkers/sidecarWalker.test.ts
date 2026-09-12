import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sidecarWalker } from "./sidecarWalker.js";

let workspaceRoot: string;

async function writeFixture(relativePath: string, content = "") {
	const absolutePath = path.join(workspaceRoot, relativePath);
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.writeFile(absolutePath, content);
}

describe("sidecarWalker", () => {
	beforeEach(async () => {
		workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sidecar-walker-"));
	});

	afterEach(async () => {
		await fs.rm(workspaceRoot, { recursive: true, force: true });
	});

	// O9-sidecar-walker-bypasses-ignore-excludes-objects: the sidecar walker
	// ignores .gitignore entirely, but still hard-excludes history/objects.
	it("finds .mdly/**/*.jsonl even under a root .gitignore excluding .mdly/, and excludes history/objects", async () => {
		await writeFixture(".gitignore", ".mdly/\n");
		await writeFixture(".mdly/comments/doc-1.jsonl", '{"id":"c1"}\n');
		await writeFixture(".mdly/comments/doc-1 2.jsonl", '{"id":"c2"}\n');
		await writeFixture(".mdly/history/objects/ab/abcd1234", "gzipped-blob");
		await writeFixture(".mdly/history/log/doc-1.jsonl", '{"id":"r1"}\n');
		await writeFixture("note.md", "not a sidecar");

		const result = await sidecarWalker(workspaceRoot);

		expect(result.files.sort()).toEqual([
			".mdly/comments/doc-1 2.jsonl",
			".mdly/comments/doc-1.jsonl",
			".mdly/history/log/doc-1.jsonl",
		]);
		expect(
			result.files.some((f) => f.startsWith(".mdly/history/objects/")),
		).toBe(false);
	});

	it("returns an empty result (not an error) when there is no .mdly folder yet", async () => {
		await writeFixture("note.md", "hello");

		const result = await sidecarWalker(workspaceRoot);

		expect(result.files).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	it("only matches .jsonl files, not other extensions inside .mdly", async () => {
		await writeFixture(".mdly/comments/doc-1.jsonl", "{}");
		await writeFixture(".mdly/comments/doc-1.jsonl.bak", "{}");
		await writeFixture(".mdly/config.json", "{}");

		const result = await sidecarWalker(workspaceRoot);

		expect(result.files).toEqual([".mdly/comments/doc-1.jsonl"]);
	});

	// sidecar-walker-details: every file carries a stat snapshot so sync's
	// cheap-stat skip can fire instead of re-reading + re-hashing each log
	// on every 250ms tick. Shape matches notesWalker exactly.
	it("returns details with size and second-resolution modifiedAt plus walk stats, matching notesWalker's shape", async () => {
		const content = '{"id":"c1"}\n';
		await writeFixture(".mdly/comments/doc-1.jsonl", content);

		const result = await sidecarWalker(workspaceRoot);

		const stat = await fs.stat(
			path.join(workspaceRoot, ".mdly/comments/doc-1.jsonl"),
		);
		expect(result.details?.[".mdly/comments/doc-1.jsonl"]).toEqual({
			size: content.length,
			modifiedAt: Math.floor(stat.mtimeMs / 1000),
		});
		expect(result.stats).toMatchObject({
			visitedEntryCount: expect.any(Number),
			visitedDirectoryCount: expect.any(Number),
		});
		expect(result.stats?.visitedEntryCount).toBeGreaterThan(0);
		expect(result.stats?.visitedDirectoryCount).toBeGreaterThan(0);
	});

	it("reports modifiedAt in SECONDS, not milliseconds — fs-node divides mtimeMs by 1000 and the cheap-stat skip compares directly", async () => {
		await writeFixture(".mdly/comments/doc-1.jsonl", "{}");

		const result = await sidecarWalker(workspaceRoot);

		const modifiedAt = result.details?.[".mdly/comments/doc-1.jsonl"]?.modifiedAt;
		expect(modifiedAt).toBeDefined();
		expect(Number.isInteger(modifiedAt)).toBe(true);
		// A millisecond clock would be ~1e12 today; seconds are ~1e9.
		// If this ever reads milliseconds, every comment log is re-read and
		// re-hashed on every sync tick.
		expect(modifiedAt).toBeLessThan(1e11);
		const stat = await fs.stat(
			path.join(workspaceRoot, ".mdly/comments/doc-1.jsonl"),
		);
		expect(modifiedAt).toBe(Math.floor(stat.mtimeMs / 1000));
	});

	// The include predicate narrows which sidecars come back (callers pass
	// isSyncedSidecarPath: comment logs + history index shards only). The
	// hard objects exclusion stays a second belt regardless of include.
	it("include narrows to synced sidecars: drops .mdly/history/<docId>.jsonl while keeping index.jsonl and index 2.jsonl", async () => {
		await writeFixture(".mdly/comments/doc-1.jsonl", "{}");
		await writeFixture(".mdly/history/doc-1.jsonl", "{}");
		await writeFixture(".mdly/history/index.jsonl", "{}");
		await writeFixture(".mdly/history/index 2.jsonl", "{}");
		await writeFixture(".mdly/history/objects/ab/abcd1234", "gzipped-blob");
		// Mirrors isSyncedSidecarPath (packages/sync/src/sidecarScope.ts) —
		// inlined here because workspace-scan must not depend on sync.
		const include = (p: string) => {
			if (p.startsWith(".mdly/comments/")) return p.endsWith(".jsonl");
			if (p.startsWith(".mdly/history/")) {
				const rest = p.slice(".mdly/history/".length);
				if (rest.includes("/")) return false;
				return /^index[^/]*\.jsonl$/i.test(rest);
			}
			return false;
		};

		const result = await sidecarWalker(workspaceRoot, { include });

		expect(result.files.sort()).toEqual([
			".mdly/comments/doc-1.jsonl",
			".mdly/history/index 2.jsonl",
			".mdly/history/index.jsonl",
		]);
	});

	it("the hard objects exclusion holds even when include would admit everything", async () => {
		await writeFixture(".mdly/history/objects/ab/abcd1234.jsonl", "blob");
		await writeFixture(".mdly/comments/doc-1.jsonl", "{}");

		const result = await sidecarWalker(workspaceRoot, { include: () => true });

		expect(result.files).toEqual([".mdly/comments/doc-1.jsonl"]);
	});
});
