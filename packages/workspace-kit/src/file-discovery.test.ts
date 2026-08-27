import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverWorkspaceFiles } from "./file-discovery";

let workspaceRoot: string;

async function writeFixture(relativePath: string, content = "") {
	const absolutePath = path.join(workspaceRoot, relativePath);
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.writeFile(absolutePath, content);
}

describe("discoverWorkspaceFiles", () => {
	beforeEach(async () => {
		workspaceRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "workspace-discovery-"),
		);
	});

	afterEach(async () => {
		await fs.rm(workspaceRoot, { recursive: true, force: true });
	});

	it("prunes generated dependency trees while retaining supported workspace files", async () => {
		await writeFixture("meeting.m4a", "audio");
		await writeFixture("node_modules/pkg/buried.m4a", "dependency audio");

		const discovery = await discoverWorkspaceFiles({
			workspaceRoot,
			isSupportedFile: (candidatePath) => candidatePath.endsWith(".m4a"),
		});

		expect(
			discovery.files.map((entry) => path.relative(workspaceRoot, entry.path)),
		).toEqual(["meeting.m4a"]);
		expect(discovery.stats.ignoredDirectoryCount).toBe(1);
	});

	it("honors nested ignore files and their negations", async () => {
		await writeFixture(".gitignore", "drafts/\n");
		await writeFixture("drafts/hidden.m4a", "hidden");
		await writeFixture("sessions/.ignore", "*.m4a\n!keep.m4a\n");
		await writeFixture("sessions/drop.m4a", "drop");
		await writeFixture("sessions/keep.m4a", "keep");

		const discovery = await discoverWorkspaceFiles({
			workspaceRoot,
			isSupportedFile: (candidatePath) => candidatePath.endsWith(".m4a"),
		});

		expect(
			discovery.files.map((entry) => path.relative(workspaceRoot, entry.path)),
		).toEqual([path.join("sessions", "keep.m4a")]);
		expect(
			discovery.isIgnoredPath(path.join(workspaceRoot, "sessions/drop.m4a")),
		).toBe(true);
		expect(
			discovery.isIgnoredPath(path.join(workspaceRoot, "sessions/keep.m4a")),
		).toBe(false);
	});

	it("fails with a typed error when the deterministic traversal budget is exceeded", async () => {
		await writeFixture("a.m4a", "one");
		await writeFixture("b.m4a", "two");

		await expect(
			discoverWorkspaceFiles({
				workspaceRoot,
				isSupportedFile: () => true,
				maxEntries: 1,
			}),
		).rejects.toMatchObject({
			code: "WORKSPACE_TRAVERSAL_LIMIT",
			limit: 1,
			visitedEntryCount: 2,
		});
	});

	it("supports product-specific internal directories without forking traversal", async () => {
		await writeFixture(".speechtodo/items/internal.m4a", "registry");
		await writeFixture("recordings/visible.m4a", "audio");

		const discovery = await discoverWorkspaceFiles({
			workspaceRoot,
			isSupportedFile: () => true,
			alwaysIgnoredDirectoryNames: [".speechtodo"],
		});

		expect(
			discovery.files.map((entry) => path.relative(workspaceRoot, entry.path)),
		).toEqual([path.join("recordings", "visible.m4a")]);
	});

	// mdly's doc-history store (R22): the desktop app wires
	// `isVisibleFolderName: (name) => !isHiddenSidebarFolderName(name)`, and
	// `isHiddenSidebarFolderName` now includes `.mdly`. This proves the
	// generic traversal engine itself honors that gate for a `.mdly/history`
	// fixture in BOTH the default and "show ignored files" modes — the same
	// two modes the sidebar's file listing supports (QA2c).
	it("hides a .mdly history store in both the default and 'show ignored files' modes", async () => {
		await writeFixture(".mdly/history/objects/ab/abcd1234", "gzipped-blob");
		await writeFixture(".mdly/history/log/doc-1.jsonl", '{"id":"r1"}\n');
		await writeFixture("note.md", "hello");
		const isVisibleFolderName = (name: string) => name !== ".mdly";

		const defaultMode = await discoverWorkspaceFiles({
			workspaceRoot,
			isSupportedFile: (candidatePath) => candidatePath.endsWith(".md"),
			isVisibleFolderName,
		});
		const showIgnoredMode = await discoverWorkspaceFiles({
			workspaceRoot,
			isSupportedFile: (candidatePath) => candidatePath.endsWith(".md"),
			isVisibleFolderName,
			includeIgnoredWorkspaceFiles: true,
		});

		for (const discovery of [defaultMode, showIgnoredMode]) {
			expect(
				discovery.folders.some((entry) => entry.path.includes(".mdly")),
			).toBe(false);
			expect(
				discovery.files.some((entry) => entry.path.includes(".mdly")),
			).toBe(false);
		}
		expect(
			defaultMode.files.map((entry) =>
				path.relative(workspaceRoot, entry.path),
			),
		).toEqual(["note.md"]);
	});
});
