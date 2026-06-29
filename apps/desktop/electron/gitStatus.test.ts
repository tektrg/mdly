import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DirectoryListing } from "../src/desktopApi/types";
import { applyGitStatusToListing, parseGitStatusPorcelain } from "./gitStatus";

const execFileAsync = promisify(execFile);
let tmpDir: string;

async function git(args: string[]) {
	await execFileAsync("git", ["-C", tmpDir, ...args]);
}

async function writeFile(relativePath: string, content = "") {
	const filePath = path.join(tmpDir, relativePath);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content);
	return filePath;
}

describe("git status sidebar indicators", () => {
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hubble-git-status-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("parses porcelain status into changed and untracked absolute paths", () => {
		const statuses = parseGitStatusPorcelain(
			[" M note.md", "?? draft.md", "R  renamed.md", "original.md", ""].join(
				"\0",
			),
			tmpDir,
		);

		expect(statuses.get(path.join(tmpDir, "note.md"))).toBe("changed");
		expect(statuses.get(path.join(tmpDir, "draft.md"))).toBe("untracked");
		expect(statuses.get(path.join(tmpDir, "renamed.md"))).toBe("changed");
		expect(statuses.has(path.join(tmpDir, "original.md"))).toBe(false);
	});

	it("applies file-only git status and skips symlinked files", async () => {
		await git(["init"]);
		const changedPath = await writeFile("changed.md", "before\n");
		const untrackedPath = await writeFile("untracked.md", "draft\n");
		await writeFile("target.md", "target\n");
		const symlinkPath = path.join(tmpDir, "linked.md");
		await fs.symlink("target.md", symlinkPath);
		await git(["add", "changed.md", "target.md"]);
		await writeFile("changed.md", "after\n");

		const listing: DirectoryListing = {
			files: [
				{ path: changedPath, modified_at: 1 },
				{ path: untrackedPath, modified_at: 1 },
				{ path: symlinkPath, modified_at: 1, is_symlink: true },
			],
			folders: [{ path: path.join(tmpDir, "folder"), modified_at: 1 }],
		};

		await applyGitStatusToListing(tmpDir, listing);

		expect(listing.files[0]?.git_status).toBe("changed");
		expect(listing.files[1]?.git_status).toBe("untracked");
		expect(listing.files[2]?.git_status).toBeUndefined();
		expect(listing.folders[0]).not.toHaveProperty("git_status");
	});

	it("matches git status when the opened workspace is a repo subfolder", async () => {
		await git(["init"]);
		const workspacePath = path.join(tmpDir, "notes");
		const changedPath = await writeFile("notes/changed.md", "before\n");
		const untrackedPath = await writeFile("notes/untracked.md", "draft\n");
		await git(["add", "notes/changed.md"]);
		await writeFile("notes/changed.md", "after\n");

		const listing: DirectoryListing = {
			files: [
				{ path: changedPath, modified_at: 1 },
				{ path: untrackedPath, modified_at: 1 },
			],
			folders: [],
		};

		await applyGitStatusToListing(workspacePath, listing);

		expect(listing.files[0]?.git_status).toBe("changed");
		expect(listing.files[1]?.git_status).toBe("untracked");
	});
});
