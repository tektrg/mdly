import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	discoverWorkspaceFiles,
	isExcludedByEntries,
	WorkspaceDirectoryLimitError,
} from "../file-discovery.js";
import { notesWalker } from "./notesWalker.js";

let workspaceRoot: string;

async function writeFixture(relativePath: string, content = "") {
	const absolutePath = path.join(workspaceRoot, relativePath);
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.writeFile(absolutePath, content);
}

describe("large-workspace sync: anchored exclusions + directory cap + walk progress", () => {
	beforeEach(async () => {
		workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lw-walker-"));
	});

	afterEach(async () => {
		await fs.rm(workspaceRoot, { recursive: true, force: true });
	});

	it("an anchored entry prunes only that path, not the same name elsewhere", async () => {
		await writeFixture("fe/docs/a.md", "a");
		await writeFixture("other/fe/docs/b.md", "b");
		await writeFixture("docs/c.md", "c");

		const { files } = await notesWalker(workspaceRoot, {
			excludedFolders: ["fe/docs"],
		});

		expect(files).toContain("other/fe/docs/b.md");
		expect(files).toContain("docs/c.md");
		expect(files).not.toContain("fe/docs/a.md");
	});

	it("a bare name still prunes at any depth alongside anchored entries", async () => {
		await writeFixture("a/node_modules/x.md", "x");
		await writeFixture("fe/docs/y.md", "y");
		await writeFixture("keep.md", "keep");

		const { files } = await notesWalker(workspaceRoot, {
			excludedFolders: ["node_modules", "fe/docs"],
		});

		expect(files).toEqual(["keep.md"]);
	});

	it("isExcludedByEntries matches the sync engine's convention", () => {
		expect(isExcludedByEntries("a/node_modules/b.md", ["node_modules"])).toBe(
			true,
		);
		expect(isExcludedByEntries("fe/docs/a.md", ["fe/docs"])).toBe(true);
		expect(isExcludedByEntries("other/fe/docs/a.md", ["fe/docs"])).toBe(false);
		expect(isExcludedByEntries("dist/a.md", ["/dist"])).toBe(true);
		expect(isExcludedByEntries("a/dist/b.md", ["/dist"])).toBe(false);
	});

	it("throws WorkspaceDirectoryLimitError past maxDirectories instead of walking forever", async () => {
		for (let i = 0; i < 8; i++)
			await writeFixture(`d${i}/note.md`, `note ${i}`);

		await expect(
			notesWalker(workspaceRoot, { maxDirectories: 3 }),
		).rejects.toThrow(WorkspaceDirectoryLimitError);
	});

	it("counts directories in stats — the watcher's actual constraint, not entries", async () => {
		await writeFixture("d0/note.md", "x");
		await writeFixture("d1/note.md", "x");

		const discovery = await discoverWorkspaceFiles({
			workspaceRoot,
			isSupportedFile: (p) => p.endsWith(".md"),
		});

		// root + 2 subdirs.
		expect(discovery.stats.visitedDirectoryCount).toBe(3);
	});

	it("emits throttled onVisit counts during the walk (indeterminate progress source)", async () => {
		for (let i = 0; i < 120; i++)
			await writeFixture(`bulk/f${i}.md`, `note ${i}`);

		const visits: {
			visitedEntryCount: number;
			visitedDirectoryCount: number;
		}[] = [];
		await notesWalker(workspaceRoot, {
			onVisit: (v) => {
				visits.push(v);
			},
		});

		expect(visits.length).toBeGreaterThan(0);
		// Every-50-entries cadence, never per file.
		expect(visits.length).toBeLessThan(20);
		for (let i = 1; i < visits.length; i++)
			expect(visits[i]?.visitedEntryCount ?? 0).toBeGreaterThan(
				visits[i - 1]?.visitedEntryCount ?? 0,
			);
	});
});

describe("D-LW1: all git ignore sources + nested-repo pruning", () => {
	let savedHome: string | undefined;
	let savedXdg: string | undefined;

	async function writeFixture(relativePath: string, content = "") {
		const absolutePath = path.join(workspaceRoot, relativePath);
		await fs.mkdir(path.dirname(absolutePath), { recursive: true });
		await fs.writeFile(absolutePath, content);
	}

	beforeEach(async () => {
		workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lw-dlw1-"));
		savedHome = process.env.HOME;
		savedXdg = process.env.XDG_CONFIG_HOME;
	});

	afterEach(async () => {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = savedXdg;
		await fs.rm(workspaceRoot, { recursive: true, force: true });
	});

	it("prunes a nested repo (directory .git) instead of descending", async () => {
		await writeFixture("worktree-a/note.md", "a");
		await writeFixture("worktree-a/.git/HEAD", "ref: main");
		await writeFixture("keep.md", "keep");

		const { files } = await notesWalker(workspaceRoot, {});
		expect(files).toEqual(["keep.md"]);
	});

	it("a worktree gitlink (.git file) also marks the boundary", async () => {
		await writeFixture("wt/note.md", "wt");
		await writeFixture("wt/.git", "gitdir: /elsewhere/repo.git/worktrees/wt");
		await writeFixture("keep.md", "keep");

		const { files } = await notesWalker(workspaceRoot, {});
		expect(files).toEqual(["keep.md"]);
	});

	it("the workspace root itself is never pruned even with its own .git", async () => {
		await writeFixture(".git/HEAD", "ref: main");
		await writeFixture("top.md", "top");

		const { files } = await notesWalker(workspaceRoot, {});
		expect(files).toEqual(["top.md"]);
	});

	it("reads .git/info/exclude at the root (the original AptusFit root cause)", async () => {
		await writeFixture(".git/info/exclude", "worktrees/\n");
		await writeFixture("worktrees/x/note.md", "junk");
		await writeFixture("real.md", "real");

		const { files } = await notesWalker(workspaceRoot, {});
		expect(files).toEqual(["real.md"]);
	});

	it("reads the global excludes file from the documented default location", async () => {
		const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "fake-home-"));
		try {
			await fs.mkdir(path.join(fakeHome, ".config", "git"), {
				recursive: true,
			});
			await fs.writeFile(
				path.join(fakeHome, ".config", "git", "ignore"),
				"scratch/\n",
			);
			process.env.HOME = fakeHome;
			delete process.env.XDG_CONFIG_HOME;

			await writeFixture("scratch/note.md", "junk");
			await writeFixture("real.md", "real");

			const { files } = await notesWalker(workspaceRoot, {});
			expect(files).toEqual(["real.md"]);
		} finally {
			await fs.rm(fakeHome, { recursive: true, force: true });
		}
	});

	it("sidebar-style listing without the flag still sees nested repos (opt-in only)", async () => {
		await writeFixture("repo/note.md", "repo");
		await writeFixture("repo/.git/HEAD", "ref: main");

		const discovery = await discoverWorkspaceFiles({
			workspaceRoot,
			isSupportedFile: (p) => p.endsWith(".md"),
		});
		expect(discovery.files.map((f) => path.basename(f.path))).toContain(
			"note.md",
		);
	});
});
