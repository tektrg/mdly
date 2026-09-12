import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assetsWalker } from "./assetsWalker.js";
import { notesWalker } from "./notesWalker.js";
import { sidecarWalker } from "./sidecarWalker.js";

let workspaceRoot: string;

async function writeFixture(relativePath: string, content = "") {
	const absolutePath = path.join(workspaceRoot, relativePath);
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.writeFile(absolutePath, content);
}

// three-walkers-distinct-scope (R13): notes / assets / sidecars each follow
// their own rules on one shared fixture — a note inside a *.assets folder,
// an image in that same folder, and a .mdly comment sidecar.
describe("notes/assets/sidecars walkers on a shared fixture", () => {
	beforeEach(async () => {
		workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "three-walkers-"));
		await writeFixture(
			"Meeting.assets/Meeting.md",
			"a note living inside an assets folder",
		);
		await writeFixture("Meeting.assets/screenshot.png", "fake-png-bytes");
		await writeFixture("Meeting.md", "the real note");
		await writeFixture(".mdly/comments/Meeting.jsonl", '{"id":"c1"}\n');
	});

	afterEach(async () => {
		await fs.rm(workspaceRoot, { recursive: true, force: true });
	});

	it("notes walker excludes both the *.assets note and the .mdly sidecar", async () => {
		const notes = await notesWalker(workspaceRoot);
		expect(notes.files).toEqual(["Meeting.md"]);
	});

	it("assets walker includes the image inside the *.assets folder", async () => {
		const assets = await assetsWalker(workspaceRoot);
		expect(assets.files).toEqual(["Meeting.assets/screenshot.png"]);
	});

	it("sidecars walker includes the .jsonl comment log", async () => {
		const sidecars = await sidecarWalker(workspaceRoot);
		expect(sidecars.files).toEqual([".mdly/comments/Meeting.jsonl"]);
	});
});
