import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assetsWalker, MAX_ASSET_SIZE } from "./assetsWalker.js";
import { notesWalker } from "./notesWalker.js";

let workspaceRoot: string;

async function writeFixture(
	relativePath: string,
	content: string | Buffer = "",
) {
	const absolutePath = path.join(workspaceRoot, relativePath);
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.writeFile(absolutePath, content);
}

describe("assetsWalker", () => {
	beforeEach(async () => {
		workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "assets-walker-"));
	});

	afterEach(async () => {
		await fs.rm(workspaceRoot, { recursive: true, force: true });
	});

	// O8-assets-walker-traverses-dot-assets: images sync even though the
	// sidebar (and the notes walker) hides `*.assets` folders.
	it("descends into *.assets folders that the notes walker (and sidebar) hide", async () => {
		await writeFixture("note.md", "hello");
		await writeFixture("note.assets/image.png", "fake-png-bytes");

		const assets = await assetsWalker(workspaceRoot);
		expect(assets.files).toEqual(["note.assets/image.png"]);

		const notes = await notesWalker(workspaceRoot);
		expect(notes.files).toEqual(["note.md"]);
	});

	it("still excludes assets over 10MB", async () => {
		await writeFixture("small.png", Buffer.alloc(1024, 1));
		await writeFixture("huge.png", Buffer.alloc(MAX_ASSET_SIZE + 1, 1));

		const assets = await assetsWalker(workspaceRoot);
		expect(assets.files).toEqual(["small.png"]);
	});

	it("still prunes .hubble and .mdly", async () => {
		await writeFixture(".hubble/thumb.png", "x");
		await writeFixture(".mdly/thumb.png", "x");
		await writeFixture("visible.png", "x");

		const assets = await assetsWalker(workspaceRoot);
		expect(assets.files).toEqual(["visible.png"]);
	});

	it("still respects .gitignore for non-asset folders", async () => {
		await writeFixture(".gitignore", "private/\n");
		await writeFixture("private/secret.png", "x");
		await writeFixture("public.png", "x");

		const assets = await assetsWalker(workspaceRoot);
		expect(assets.files).toEqual(["public.png"]);
	});
});
