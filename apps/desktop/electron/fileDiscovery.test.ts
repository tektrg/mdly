import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DirectoryListing } from "../src/desktopApi/types";
import { collectDocumentFiles } from "./fileDiscovery";

let tmpDir: string;

async function writeFile(relativePath: string, content = "") {
	const filePath = path.join(tmpDir, relativePath);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content);
}

function relativePaths(paths: { path: string }[]) {
	return paths
		.map((entry) => path.relative(tmpDir, entry.path).split(path.sep).join("/"))
		.sort();
}

function relativeEntry<T extends { path: string }>(entries: T[], relativePath: string) {
	return entries.find(
		(entry) =>
			path.relative(tmpDir, entry.path).split(path.sep).join("/") ===
			relativePath,
	);
}

describe("collectDocumentFiles", () => {
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hubble-discovery-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("honors gitignore negation patterns when parent folders remain traversable", async () => {
		await writeFile(
			".gitignore",
			[".agents/*", "!.agents/skills/", "!.agents/skills/**", ""].join("\n"),
		);
		await writeFile(".agents/skills/fix/SKILL.md", "# Fix");
		await writeFile(".agents/other/NOTE.md", "# Other");
		await writeFile("visible.md", "# Visible");

		const listing: DirectoryListing = { files: [], folders: [] };
		await collectDocumentFiles(tmpDir, listing);

		expect(relativePaths(listing.files)).toEqual([
			".agents/skills/fix/SKILL.md",
			"visible.md",
		]);
		expect(relativePaths(listing.folders)).toContain(".agents/skills");
		expect(relativePaths(listing.folders)).not.toContain(".agents/other");
	});

	it("can include user-ignored files while still pruning expensive workspace directories", async () => {
		await writeFile(".gitignore", [".agents", "node_modules", ""].join("\n"));
		await writeFile(".agents/skills/fix/SKILL.md", "# Fix");
		await writeFile("node_modules/pkg/README.md", "# Dependency");
		await writeFile("visible.md", "# Visible");

		const listing: DirectoryListing = { files: [], folders: [] };
		await collectDocumentFiles(tmpDir, listing, {
			includeIgnoredWorkspaceFiles: true,
		});

		expect(relativePaths(listing.files)).toEqual([
			".agents/skills/fix/SKILL.md",
			"visible.md",
		]);
		expect(relativePaths(listing.folders)).not.toContain("node_modules");
	});

	it("always prunes the generated dev Electron app bundle", async () => {
		await writeFile(
			"apps/desktop/.dev-electron/playground/README.md",
			"# Playground",
		);
		await writeFile("visible.md", "# Visible");

		const listing: DirectoryListing = { files: [], folders: [] };
		await collectDocumentFiles(tmpDir, listing, {
			includeIgnoredWorkspaceFiles: true,
		});

		expect(relativePaths(listing.files)).toEqual(["visible.md"]);
		expect(relativePaths(listing.folders)).not.toContain(
			"apps/desktop/.dev-electron",
		);
	});

	it("still lists files when the workspace root itself sits inside a .dev-electron folder", async () => {
		const workspaceRoot = path.join(tmpDir, ".dev-electron", "playground");
		await writeFile(
			path.join(".dev-electron", "playground", "README.md"),
			"# Playground",
		);
		await writeFile(
			path.join(".dev-electron", "playground", "samples", "note.md"),
			"# Note",
		);

		const listing: DirectoryListing = { files: [], folders: [] };
		await collectDocumentFiles(workspaceRoot, listing, {
			includeIgnoredWorkspaceFiles: true,
		});

		expect(
			listing.files
				.map((entry) =>
					path.relative(workspaceRoot, entry.path).split(path.sep).join("/"),
				)
				.sort(),
		).toEqual(["README.md", "samples/note.md"]);
	});

	it("marks document symlinks in the listing", async () => {
		await writeFile("target.md", "# Target");
		await fs.symlink("target.md", path.join(tmpDir, "linked.md"));

		const listing: DirectoryListing = { files: [], folders: [] };
		await collectDocumentFiles(tmpDir, listing);

		const linked = relativeEntry(listing.files, "linked.md");
		expect(linked).toMatchObject({
			is_symlink: true,
			symlink_target: path.join(tmpDir, "target.md"),
			symlink_target_exists: true,
			symlink_target_in_workspace: true,
			symlink_canonical_path: path.join(tmpDir, "target.md"),
		});
	});

	it("shows canonical folder children when a symlink and canonical folder are both visible", async () => {
		await writeFile("target/note.md", "# Target");
		await fs.symlink("target", path.join(tmpDir, "linked-folder"));

		const listing: DirectoryListing = { files: [], folders: [] };
		await collectDocumentFiles(tmpDir, listing);

		expect(relativePaths(listing.files)).toContain("target/note.md");
		expect(relativePaths(listing.files)).not.toContain("linked-folder/note.md");
		expect(relativeEntry(listing.folders, "linked-folder")).toMatchObject({
			is_symlink: true,
			symlink_target: path.join(tmpDir, "target"),
			symlink_target_exists: true,
			symlink_target_in_workspace: true,
			symlink_canonical_path: path.join(tmpDir, "target"),
		});
	});

	it("lets canonical folders own children even when the symlink is encountered first", async () => {
		await writeFile("z-target/note.md", "# Target");
		await fs.symlink("z-target", path.join(tmpDir, "a-linked-folder"));

		const listing: DirectoryListing = { files: [], folders: [] };
		await collectDocumentFiles(tmpDir, listing);

		expect(relativePaths(listing.files)).toContain("z-target/note.md");
		expect(relativePaths(listing.files)).not.toContain(
			"a-linked-folder/note.md",
		);
		expect(relativeEntry(listing.folders, "a-linked-folder")).toMatchObject({
			is_symlink: true,
			symlink_canonical_path: path.join(tmpDir, "z-target"),
		});
	});

	it("keeps external symlinked folders as pointer rows without traversal", async () => {
		const externalDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "hubble-discovery-external-"),
		);
		try {
			await fs.mkdir(path.join(externalDir, "target"), { recursive: true });
			await fs.writeFile(path.join(externalDir, "target", "note.md"), "# Target");
			await fs.symlink(
				path.join(externalDir, "target"),
				path.join(tmpDir, "linked-folder"),
			);

			const listing: DirectoryListing = { files: [], folders: [] };
			await collectDocumentFiles(tmpDir, listing);

			expect(relativePaths(listing.files)).not.toContain(
				"linked-folder/note.md",
			);
			expect(relativeEntry(listing.folders, "linked-folder")).toMatchObject({
				is_symlink: true,
				symlink_target: path.join(externalDir, "target"),
				symlink_target_exists: true,
				symlink_target_in_workspace: false,
				symlink_canonical_path: null,
			});
		} finally {
			await fs.rm(externalDir, { recursive: true, force: true });
		}
	});

	it("does not traverse in-workspace symlinks to ignored heavy folders", async () => {
		await writeFile("node_modules/pkg/README.md", "# Dependency");
		await fs.symlink("node_modules", path.join(tmpDir, "deps"));

		const listing: DirectoryListing = { files: [], folders: [] };
		await collectDocumentFiles(tmpDir, listing);

		expect(relativePaths(listing.files)).not.toContain("deps/pkg/README.md");
		expect(relativePaths(listing.folders)).not.toContain("node_modules");
		expect(relativeEntry(listing.folders, "deps")).toMatchObject({
			is_symlink: true,
			symlink_target: path.join(tmpDir, "node_modules"),
			symlink_target_exists: true,
			symlink_target_in_workspace: true,
			symlink_canonical_path: null,
		});
	});

	it("shows broken symlinks without failing discovery", async () => {
		await fs.symlink("missing.md", path.join(tmpDir, "broken.md"));
		await fs.symlink("missing-folder", path.join(tmpDir, "broken-folder"));

		const listing: DirectoryListing = { files: [], folders: [] };
		await collectDocumentFiles(tmpDir, listing);

		expect(relativeEntry(listing.files, "broken.md")).toMatchObject({
			is_symlink: true,
			symlink_target: path.join(tmpDir, "missing.md"),
			symlink_target_exists: false,
		});
		expect(relativeEntry(listing.folders, "broken-folder")).toMatchObject({
			is_symlink: true,
			symlink_target: path.join(tmpDir, "missing-folder"),
			symlink_target_exists: false,
		});
	});

	it("does not recurse forever through directory symlink cycles", async () => {
		await writeFile("loop/note.md", "# Loop");
		await fs.symlink("..", path.join(tmpDir, "loop/back"));

		const listing: DirectoryListing = { files: [], folders: [] };
		await collectDocumentFiles(tmpDir, listing);

		expect(relativePaths(listing.files)).toEqual(["loop/note.md"]);
		expect(relativeEntry(listing.folders, "loop/back")).toMatchObject({
			is_symlink: true,
			symlink_target_exists: true,
		});
	});
});
