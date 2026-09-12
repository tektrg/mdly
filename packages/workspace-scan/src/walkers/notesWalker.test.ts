import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverWorkspaceFiles } from "../file-discovery.js";
import { notesWalker } from "./notesWalker.js";
import { isHiddenSidebarFolderName } from "./shared.js";

let workspaceRoot: string;

async function writeFixture(relativePath: string, content = "") {
	const absolutePath = path.join(workspaceRoot, relativePath);
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.writeFile(absolutePath, content);
}

/** The behaviour being replaced (R14): today's `packages/sync/src/fs-node.ts`
 * skips EVERY dot-prefixed entry and reads no ignore file at all. Reimplemented
 * here, standalone, purely to prove the contrast — this is not imported from
 * fs-node.ts, since that file is being switched onto the new walker in this
 * same delivery. */
async function oldBlanketDotSkipWalk(
	dir: string,
	root: string,
	out: string[],
): Promise<void> {
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await oldBlanketDotSkipWalk(full, root, out);
		} else if (/\.(md|markdown|mdown)$/i.test(entry.name)) {
			out.push(path.relative(root, full).split(path.sep).join("/"));
		}
	}
}

describe("notesWalker", () => {
	beforeEach(async () => {
		workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "notes-walker-"));
	});

	afterEach(async () => {
		await fs.rm(workspaceRoot, { recursive: true, force: true });
	});

	// gitignore-respected-in-cloud-walker (R14): exact parity with the
	// sidebar's own engine call, including a nested-ignore negation pattern.
	it("matches discoverWorkspaceFiles exactly for a fixture with a nested negation pattern", async () => {
		await writeFixture(".gitignore", "drafts/\n");
		await writeFixture("drafts/hidden.md", "hidden");
		await writeFixture("sessions/.ignore", "*.md\n!keep.md\n");
		await writeFixture("sessions/drop.md", "drop");
		await writeFixture("sessions/keep.md", "keep");
		await writeFixture(".somefolder/note.md", "newly included");

		const isVisibleFolderName = (name: string) =>
			!isHiddenSidebarFolderName(name);
		const isSupportedFile = (p: string) => /\.(md|markdown|mdown)$/i.test(p);

		const reference = await discoverWorkspaceFiles({
			workspaceRoot,
			isSupportedFile,
			isVisibleFolderName,
		});
		const referencePaths = reference.files
			.map((entry) =>
				path.relative(workspaceRoot, entry.path).split(path.sep).join("/"),
			)
			.sort();

		const walked = await notesWalker(workspaceRoot);

		expect(walked.files).toEqual(referencePaths);
		expect(walked.files).toEqual([".somefolder/note.md", "sessions/keep.md"]);
	});

	// O6-gitignore-exclusion (pass condition d): a gitignored note never syncs.
	it("never includes a file matching .gitignore", async () => {
		await writeFixture(".gitignore", "secret.md\n");
		await writeFixture("secret.md", "shh");
		await writeFixture("public.md", "hi");

		const walked = await notesWalker(workspaceRoot);

		expect(walked.files).toEqual(["public.md"]);
	});

	// O7-dot-folder-behaviour-change-visible (R14): the deliberate behaviour
	// change — a non-ignored file inside a dot-folder now syncs, whereas the
	// old blanket-dot-skip rule it replaces never returned it.
	it("includes a non-ignored file inside a dot-folder, unlike the old blanket dot-skip rule", async () => {
		await writeFixture(".somefolder/note.md", "newly included");

		const walked = await notesWalker(workspaceRoot);
		expect(walked.files).toEqual([".somefolder/note.md"]);

		const oldRuleResult: string[] = [];
		await oldBlanketDotSkipWalk(workspaceRoot, workspaceRoot, oldRuleResult);
		expect(oldRuleResult).toEqual([]);
	});

	// A file matching .gitignore never appears even inside a dot-folder
	// (R14's other half of the same rule).
	it("still excludes a gitignored file even inside a now-visible dot-folder", async () => {
		await writeFixture(".somefolder/.gitignore", "secret.md\n");
		await writeFixture(".somefolder/secret.md", "shh");
		await writeFixture(".somefolder/visible.md", "hi");

		const walked = await notesWalker(workspaceRoot);
		expect(walked.files).toEqual([".somefolder/visible.md"]);
	});

	// .mdly and .hubble are never walked as notes even though dot-folders
	// now sync in general.
	it("never walks .mdly or .hubble as notes", async () => {
		await writeFixture(".mdly/comments/doc.jsonl", "{}");
		await writeFixture(".mdly/note-lookalike.md", "should not appear");
		await writeFixture(".hubble/config.json", "{}");
		await writeFixture(".hubble/note-lookalike.md", "should not appear");
		await writeFixture("real.md", "kept");

		const walked = await notesWalker(workspaceRoot);
		expect(walked.files).toEqual(["real.md"]);
	});

	// Regression: `.claude` is not covered by isHiddenSidebarFolderName, nor
	// (in AptusFit's real .gitignore) by any ignore rule — it's deliberately
	// un-ignored there for unrelated reasons — so without this option a
	// workspace's `.claude` folder (which can hold tens of thousands of
	// churning git-worktree entries) was walked in full. A caller's
	// excludedFolders (e.g. Cloud Sync's effectiveExcludedFolders(), which
	// already prunes `.claude` for the desktop watcher) must prune the sync
	// walk too. Fails on the old signature (no second argument existed and
	// nothing else hides `.claude`), passes once excludedFolders reaches
	// discoverWorkspaceFiles's alwaysIgnoredDirectoryNames.
	it("prunes a caller-supplied excludedFolders entry that no other rule hides", async () => {
		await writeFixture(".claude/worktrees/note.md", "should not appear");
		await writeFixture("real.md", "kept");

		const withoutOption = await notesWalker(workspaceRoot);
		expect(withoutOption.files).toEqual([
			".claude/worktrees/note.md",
			"real.md",
		]);

		const walked = await notesWalker(workspaceRoot, {
			excludedFolders: [".claude"],
		});
		expect(walked.files).toEqual(["real.md"]);
	});
});
