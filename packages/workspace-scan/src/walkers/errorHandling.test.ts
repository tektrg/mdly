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

// QA2a / R15 — a single unreadable file (permission denied, broken symlink)
// mid-walk must not abort the walk for the rest of the workspace: every
// other readable file still comes back, and the bad path is reported
// separately rather than the walker throwing.
describe("walkers tolerate an unreadable path mid-walk (R15)", () => {
	beforeEach(async () => {
		workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "walker-errors-"));
	});

	afterEach(async () => {
		await fs.rm(workspaceRoot, { recursive: true, force: true });
	});

	it("notesWalker: a broken symlink doesn't abort the walk", async () => {
		await writeFixture("kept-before.md", "kept");
		await fs.symlink("nowhere.md", path.join(workspaceRoot, "broken.md"));
		await writeFixture("kept-after.md", "kept");

		const result = await notesWalker(workspaceRoot);

		expect(result.files).toEqual(
			expect.arrayContaining(["kept-before.md", "kept-after.md"]),
		);
	});

	it("notesWalker: a permission-denied directory doesn't abort the walk; the bad path is reported separately", async () => {
		await writeFixture("locked/secret.md", "secret");
		await writeFixture("visible.md", "kept");
		const lockedDir = path.join(workspaceRoot, "locked");
		await fs.chmod(lockedDir, 0o000);

		try {
			const result = await notesWalker(workspaceRoot);

			expect(result.files).toEqual(["visible.md"]);

			if (process.getuid?.() === 0) return; // root bypasses permission bits
			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors.some((e) => e.path === lockedDir)).toBe(true);
			// The bad path must never silently appear as if it were readable.
			expect(result.files).not.toContain("locked/secret.md");
		} finally {
			await fs.chmod(lockedDir, 0o755);
		}
	});

	it("assetsWalker: a permission-denied directory doesn't abort the walk", async () => {
		await writeFixture("locked/secret.png", "secret");
		await writeFixture("visible.png", "kept");
		const lockedDir = path.join(workspaceRoot, "locked");
		await fs.chmod(lockedDir, 0o000);

		try {
			const result = await assetsWalker(workspaceRoot);
			expect(result.files).toEqual(["visible.png"]);
			if (process.getuid?.() === 0) return;
			expect(result.errors.some((e) => e.path === lockedDir)).toBe(true);
		} finally {
			await fs.chmod(lockedDir, 0o755);
		}
	});

	it("sidecarWalker: a permission-denied directory under .mdly doesn't abort the walk", async () => {
		await writeFixture(".mdly/comments/keep.jsonl", "{}");
		await writeFixture(".mdly/locked/secret.jsonl", "{}");
		const lockedDir = path.join(workspaceRoot, ".mdly", "locked");
		await fs.chmod(lockedDir, 0o000);

		try {
			const result = await sidecarWalker(workspaceRoot);
			expect(result.files).toEqual([".mdly/comments/keep.jsonl"]);
			if (process.getuid?.() === 0) return;
			expect(result.errors.some((e) => e.path === lockedDir)).toBe(true);
		} finally {
			await fs.chmod(lockedDir, 0o755);
		}
	});
});
