import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	appExcludedEntries,
	BUILT_IN_DEFAULT_FILES_SCOPE,
	createGitignoreEvaluator,
	discoverWorkspaceFiles,
	isExcludedByEntries,
	parseFilesScope,
	resolveWorkspaceFilesScope,
	syncExcludedEntries,
	withSyncExclusions,
} from "./file-discovery.js";

describe("files scope rules", () => {
	it("unchecking In app forces Synced off (synced ⊆ visible)", () => {
		const scope = parseFilesScope({
			rules: [{ pattern: "drafts", inApp: false, synced: true }],
		});
		expect(scope?.rules).toEqual([
			{ pattern: "drafts", inApp: false, synced: false },
		]);
		expect(scope?.respectGitignore).toBe(true);
	});

	it("drops built-in, blank and duplicate rows", () => {
		const scope = parseFilesScope({
			respectGitignore: false,
			rules: [
				{ pattern: "node_modules", inApp: true, synced: true },
				{ pattern: " ", inApp: true, synced: true },
				{ pattern: "a", inApp: true, synced: true },
				{ pattern: "a", inApp: false, synced: false },
			],
		});
		expect(scope).toEqual({
			respectGitignore: false,
			rules: [{ pattern: "a", inApp: true, synced: true }],
		});
	});

	it("migrates legacy cloudSync.excludedFolders to In app ✓ / Synced ✗", () => {
		const scope = resolveWorkspaceFilesScope({
			cloudSync: { excludedFolders: [".git", ".claude", "fe/docs"] },
		});
		expect(scope.rules).toEqual([
			{ pattern: ".claude", inApp: true, synced: false },
			{ pattern: "fe/docs", inApp: true, synced: false },
		]);
		// Sidebar unchanged: nothing extra hidden from the app.
		expect(appExcludedEntries(scope)).toEqual([]);
		expect(syncExcludedEntries(scope)).toEqual(
			expect.arrayContaining([".git", ".claude", "fe/docs"]),
		);
		// Asset folders must stay reachable for the assets walker.
		expect(syncExcludedEntries(scope)).not.toContain("*.assets");
	});

	it("a workspace's own scope wins; no config seeds from the global defaults", () => {
		const own = { respectGitignore: false, rules: [] };
		expect(
			resolveWorkspaceFilesScope({
				scope: own,
				cloudSync: { excludedFolders: ["x"] },
			}),
		).toEqual(own);
		expect(resolveWorkspaceFilesScope({})).toEqual(
			BUILT_IN_DEFAULT_FILES_SCOPE,
		);
		const defaults = {
			respectGitignore: false,
			rules: [{ pattern: "tmp", inApp: false, synced: false }],
		};
		expect(resolveWorkspaceFilesScope(null, defaults)).toEqual(defaults);
	});

	it("withSyncExclusions makes exactly the listed patterns non-synced", () => {
		const next = withSyncExclusions(
			{
				respectGitignore: true,
				rules: [
					{ pattern: "a", inApp: true, synced: false },
					{ pattern: "hidden", inApp: false, synced: false },
				],
			},
			["b"],
		);
		expect(next.rules).toEqual([
			{ pattern: "a", inApp: true, synced: true },
			{ pattern: "hidden", inApp: false, synced: false },
			{ pattern: "b", inApp: true, synced: false },
		]);
	});

	it("glob patterns use gitignore matching", () => {
		expect(isExcludedByEntries("x/y.assets/z.png", ["*.assets"])).toBe(true);
		expect(isExcludedByEntries("notes/a.log", ["*.log"])).toBe(true);
		expect(isExcludedByEntries("notes/a.md", ["*.log"])).toBe(false);
		expect(isExcludedByEntries("drafts/a.md", ["/drafts/*.md"])).toBe(true);
		expect(isExcludedByEntries("x/drafts/a.md", ["/drafts/*.md"])).toBe(false);
	});
});

async function makeWorkspace(files: Record<string, string>) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "files-scope-"));
	for (const [rel, content] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
		await fs.writeFile(path.join(root, rel), content);
	}
	return root;
}

describe("files scope in discovery", () => {
	it("hides In-app-excluded rules even when .gitignore is not respected", async () => {
		const root = await makeWorkspace({
			".gitignore": "ignored.md\n",
			"ignored.md": "",
			"keep.md": "",
			"private/a.md": "",
		});
		const listed = await discoverWorkspaceFiles({
			workspaceRoot: root,
			isSupportedFile: (p) => p.endsWith(".md"),
			includeIgnoredWorkspaceFiles: true,
			alwaysIgnoredDirectoryNames: ["private"],
		});
		expect(listed.files.map((f) => path.relative(root, f.path)).sort()).toEqual(
			["ignored.md", "keep.md"],
		);
	});
});

describe("createGitignoreEvaluator", () => {
	it("evaluates nested ignore files and negation on reported paths", async () => {
		const root = await makeWorkspace({
			".gitignore": "*.tmp\nlogs/\n",
			"sub/.gitignore": "!keep.tmp\n",
		});
		const evaluator = createGitignoreEvaluator(root);
		expect(await evaluator.isIgnored(path.join(root, "a.tmp"))).toBe(true);
		expect(await evaluator.isIgnored(path.join(root, "logs/x.md"))).toBe(true);
		expect(await evaluator.isIgnored(path.join(root, "sub/keep.tmp"))).toBe(
			false,
		);
		expect(await evaluator.isIgnored(path.join(root, "note.md"))).toBe(false);
		await fs.writeFile(path.join(root, ".gitignore"), "");
		expect(await evaluator.isIgnored(path.join(root, "a.tmp"))).toBe(true);
		evaluator.invalidate();
		expect(await evaluator.isIgnored(path.join(root, "a.tmp"))).toBe(false);
	});
});
