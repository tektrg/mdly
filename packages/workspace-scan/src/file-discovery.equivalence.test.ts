import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	discoverWorkspaceFiles,
	type WorkspaceDiscoveryOptions,
} from "./file-discovery";
import { discoverWorkspaceFiles as serialDiscoverWorkspaceFiles } from "./test-support/serialFileDiscovery";

// The prefetching walk must be observably identical to the frozen serial
// walk: same files/folders in the same order, same symlink metadata, stats,
// errors, limit errors, onVisit sequence and isIgnoredPath verdicts.

let root: string;
let savedXdg: string | undefined;

async function write(rel: string, content = "x") {
	const abs = path.join(root, rel);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content);
}

type Outcome = {
	result?: unknown;
	error?: unknown;
	visits: unknown[];
};

async function run(
	walk: typeof discoverWorkspaceFiles,
	options: Omit<WorkspaceDiscoveryOptions, "workspaceRoot" | "onVisit">,
): Promise<Outcome> {
	const visits: unknown[] = [];
	try {
		const result = await walk({
			...options,
			workspaceRoot: root,
			onVisit: (v) => visits.push({ ...v }),
		});
		const { durationMs: _ignored, ...stats } = result.stats;
		const probes = [
			"a.md",
			"drafts/x.md",
			"drafts/keep.md",
			"sub/build/out.md",
			"sub/notes.log",
			"sub/deep/again.md",
			"global-ignored.md",
			"repo/inner.md",
			"node_modules/pkg/x.md",
		].map((rel) => result.isIgnoredPath(path.join(root, rel)));
		return {
			result: {
				files: result.files,
				folders: result.folders,
				stats,
				errors: result.errors,
				probes,
			},
			visits,
		};
	} catch (error) {
		const e = error as Error & Record<string, unknown>;
		return {
			error: {
				name: e.name,
				message: e.message,
				code: e.code,
				limit: e.limit,
				visitedEntryCount: e.visitedEntryCount,
				visitedDirectoryCount: e.visitedDirectoryCount,
			},
			visits,
		};
	}
}

async function expectEquivalent(
	options: Omit<WorkspaceDiscoveryOptions, "workspaceRoot" | "onVisit">,
) {
	const serial = await run(serialDiscoverWorkspaceFiles, options);
	const prefetched = await run(discoverWorkspaceFiles, options);
	expect(prefetched).toEqual(serial);
	return prefetched;
}

const isMd = (p: string) => p.endsWith(".md");

describe("discoverWorkspaceFiles equivalence with the serial walk", () => {
	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "discovery-equiv-"));
		savedXdg = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = path.join(
			root,
			"..",
			`${path.basename(root)}-xdg`,
		);
		await fs.mkdir(path.join(process.env.XDG_CONFIG_HOME, "git"), {
			recursive: true,
		});
		await fs.writeFile(
			path.join(process.env.XDG_CONFIG_HOME, "git", "ignore"),
			"global-ignored.md\n",
		);

		await write(".gitignore", "drafts/*\n!drafts/keep.md\n*.log\n");
		await write(".git/info/exclude", "excluded-by-git/\n");
		await write("a.md");
		await write("B.md");
		await write("ä-umlaut.md");
		await write("global-ignored.md");
		await write("drafts/x.md");
		await write("drafts/keep.md");
		await write("excluded-by-git/y.md");
		await write("sub/.ignore", "build/\n");
		await write("sub/notes.log");
		await write("sub/notes.md");
		await write("sub/build/out.md");
		await write("sub/deep/.gitignore", "!*.log\nskip.md\n");
		await write("sub/deep/again.md");
		await write("sub/deep/skip.md");
		await write("sub/deep/kept.log");
		await write("sub/img.assets/pic.png");
		await write(".mdly/comments/a.jsonl");
		await write("node_modules/pkg/x.md");
		await write("repo/.git", "gitdir: elsewhere\n");
		await write("repo/inner.md");
		await write("repo2/.git/HEAD", "ref\n");
		await write("repo2/inner.md");
		await write("excluded/name/z.md");
		// Wide + deep generated content so ordering under read-ahead is real.
		for (let d = 0; d < 12; d++) {
			for (let f = 0; f < 15; f++) {
				await write(`gen/d${d % 4}/n${d}/f${(f * 7) % 15}.md`);
			}
		}
		// Symlinks: file, dir, broken, cycle to an ancestor, and outside.
		await fs.symlink(path.join(root, "a.md"), path.join(root, "link-a.md"));
		await fs.symlink(path.join(root, "sub"), path.join(root, "link-sub"));
		await fs.symlink(
			path.join(root, "missing.md"),
			path.join(root, "broken.md"),
		);
		await fs.symlink("..", path.join(root, "sub", "deep", "cycle"));
		await fs.symlink(os.tmpdir(), path.join(root, "outside"));
	});

	afterAll(async () => {
		if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = savedXdg;
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(path.join(root, "..", `${path.basename(root)}-xdg`), {
			recursive: true,
			force: true,
		});
	});

	it("default options", async () => {
		const outcome = await expectEquivalent({ isSupportedFile: isMd });
		expect(outcome.error).toBeUndefined();
		const r = outcome.result as { files: unknown[]; folders: unknown[] };
		expect(r.files.length).toBeGreaterThan(150);
		expect(outcome.visits.length).toBeGreaterThan(0);
	});

	it("nested-repo pruning", async () => {
		const outcome = await expectEquivalent({
			isSupportedFile: isMd,
			pruneNestedRepos: true,
		});
		expect(
			(outcome.result as { stats: { prunedNestedRepoCount: number } }).stats
				.prunedNestedRepoCount,
		).toBe(2);
	});

	it("ignore files disabled", async () => {
		await expectEquivalent({
			isSupportedFile: isMd,
			includeIgnoredWorkspaceFiles: true,
		});
	});

	it("visible-folder filter, excluded names and anchored paths", async () => {
		await expectEquivalent({
			isSupportedFile: (p) => isMd(p) || p.endsWith(".png"),
			isVisibleFolderName: (n) => !n.endsWith(".assets") && n !== ".mdly",
			alwaysIgnoredDirectoryNames: ["excluded/name", "d2", "*.log"],
		});
	});

	it.each([1, 7, 40, 120])("maxEntries=%i", async (maxEntries) => {
		const outcome = await expectEquivalent({
			isSupportedFile: isMd,
			maxEntries,
		});
		expect(outcome.error).toBeDefined();
	});

	it.each([1, 3, 9])("maxDirectories=%i", async (maxDirectories) => {
		const outcome = await expectEquivalent({
			isSupportedFile: isMd,
			maxDirectories,
		});
		expect(outcome.error).toBeDefined();
	});

	it("already-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort(new Error("stop"));
		const outcome = await expectEquivalent({
			isSupportedFile: isMd,
			signal: controller.signal,
		});
		expect(outcome.error).toMatchObject({ message: "stop" });
	});

	it("unreadable directory is reported, not fatal", async () => {
		if (process.getuid?.() === 0) return;
		await write("locked/secret.md");
		await fs.chmod(path.join(root, "locked"), 0o000);
		try {
			const outcome = await expectEquivalent({ isSupportedFile: isMd });
			expect(
				(outcome.result as { errors: unknown[] }).errors.length,
			).toBeGreaterThan(0);
		} finally {
			await fs.chmod(path.join(root, "locked"), 0o755);
			await fs.rm(path.join(root, "locked"), { recursive: true });
		}
	});
});
