import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { notesWalker } from "@mdly/workspace-scan";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentHash } from "./fs.js";
import {
	createNodeFileSystem,
	WorkspaceTraversalLimitError,
} from "./fs-node.js";

vi.mock("@mdly/workspace-scan", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@mdly/workspace-scan")>();
	return {
		...actual,
		notesWalker: vi.fn(actual.notesWalker),
	};
});

let workspaceRoot: string;

async function writeFixture(relativePath: string, content = "") {
	const absolutePath = path.join(workspaceRoot, relativePath);
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.writeFile(absolutePath, content);
}

// packages/sync no longer has its own separate, cruder dot-skip logic after
// slice 1.3 — listMarkdownFiles/listAssetFiles are now backed by the same
// walkers the CLI dry-run uses (R12-R14).
describe("createNodeFileSystem (walker-backed, R12-R14)", () => {
	beforeEach(async () => {
		workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fs-node-"));
	});

	afterEach(async () => {
		await fs.rm(workspaceRoot, { recursive: true, force: true });
	});

	it("includes a non-ignored file inside a dot-folder, with real content and hash — the R14 behaviour change", async () => {
		await writeFixture(".somefolder/note.md", "hello world");

		const files = await createNodeFileSystem().listMarkdownFiles(workspaceRoot);

		expect(files).toHaveLength(1);
		expect(files[0]?.relativePath).toBe(".somefolder/note.md");
		expect(files[0]?.content).toBe("hello world");
		expect(files[0]?.hash).toBe(await contentHash("hello world"));
	});

	it("never syncs a file matching .gitignore", async () => {
		await writeFixture(".gitignore", "secret.md\n");
		await writeFixture("secret.md", "shh");
		await writeFixture("public.md", "hi");

		const files = await createNodeFileSystem().listMarkdownFiles(workspaceRoot);

		expect(files.map((f) => f.relativePath)).toEqual(["public.md"]);
	});

	it("never walks .mdly or .hubble as notes even though dot-folders sync in general now", async () => {
		await writeFixture(".mdly/note-lookalike.md", "should not appear");
		await writeFixture(".hubble/config.json", "{}");
		await writeFixture("real.md", "kept");

		const files = await createNodeFileSystem().listMarkdownFiles(workspaceRoot);

		expect(files.map((f) => f.relativePath)).toEqual(["real.md"]);
	});

	it("lists an image inside a *.assets folder and excludes one over 10MB", async () => {
		await writeFixture("note.assets/small.png", "tiny-image-bytes");
		await writeFixture(
			"note.assets/huge.png",
			"x".repeat(10 * 1024 * 1024 + 1),
		);

		const assets = await createNodeFileSystem().listAssetFiles(workspaceRoot);

		expect(assets.map((a) => a.relativePath)).toEqual([
			"note.assets/small.png",
		]);
	});

	// Regression: listMarkdownFiles used to read every walked path in a second,
	// separate pass with no error handling — a file (or a whole subtree, e.g. a
	// git worktree) deleted between the walk and the read threw ENOENT and
	// killed the entire sync run, which cloudSyncWiring.ts then misclassified
	// as "the workspace folder is gone". Fails on the old code (throws), passes
	// on the fix (the vanished file is skipped, the rest still returns).
	it("skips a file the walker found but that vanished before it could be read, instead of throwing", async () => {
		await writeFixture("real.md", "kept");
		vi.mocked(notesWalker).mockResolvedValueOnce({
			files: ["ghost.md", "real.md"],
			errors: [],
		});

		const files = await createNodeFileSystem().listMarkdownFiles(workspaceRoot);

		expect(files.map((f) => f.relativePath)).toEqual(["real.md"]);
	});

	it("passes excludedFolders and maxEntries through to notesWalker", async () => {
		await writeFixture("real.md", "kept");

		await createNodeFileSystem({
			excludedFolders: ["node_modules"],
			maxEntries: 5,
		}).listMarkdownFiles(workspaceRoot);

		expect(notesWalker).toHaveBeenCalledWith(workspaceRoot, {
			excludedFolders: ["node_modules"],
			maxEntries: 5,
		});
	});

	it("propagates WorkspaceTraversalLimitError when the walk exceeds maxEntries, rather than swallowing it", async () => {
		await writeFixture("one.md", "1");
		await writeFixture("two.md", "2");
		await writeFixture("three.md", "3");

		await expect(
			createNodeFileSystem({ maxEntries: 1 }).listMarkdownFiles(workspaceRoot),
		).rejects.toThrow(WorkspaceTraversalLimitError);
	});
});
