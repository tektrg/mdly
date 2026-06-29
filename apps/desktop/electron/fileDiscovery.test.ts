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
		});
	});

	it("traverses symlinked folders and marks the folder row", async () => {
		await writeFile("target/note.md", "# Target");
		await fs.symlink("target", path.join(tmpDir, "linked-folder"));

		const listing: DirectoryListing = { files: [], folders: [] };
		await collectDocumentFiles(tmpDir, listing);

		expect(relativePaths(listing.files)).toContain("linked-folder/note.md");
		expect(relativeEntry(listing.folders, "linked-folder")).toMatchObject({
			is_symlink: true,
			symlink_target: path.join(tmpDir, "target"),
			symlink_target_exists: true,
		});
	});

	it("shows broken symlinks without failing discovery", async () => {
		await fs.symlink("missing.md", path.join(tmpDir, "broken.md"));
		await fs.symlink("missing-folder", path.join(tmpDir, "broken-folder"));

		const listing: DirectoryListing = { files: [], folders: [] };
		await collectDocumentFiles(tmpDir, listing);

		expect(relativeEntry(listing.files, "broken.md")).toMatchObject({
			is_symlink: true,
			symlink_target_exists: false,
		});
		expect(relativeEntry(listing.folders, "broken-folder")).toMatchObject({
			is_symlink: true,
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
