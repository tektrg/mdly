/**
 * Watch-scope filter coverage for the quit-hang fix: the Cloud Sync chokidar
 * watcher must earn an OS handle only for documents and the already
 * special-cased sidecars — never for the tens of thousands of code/asset
 * files a workspace can hold. Directories must stay walkable (chokidar
 * prunes whole subtrees whose directory is ignored), so only FILES get the
 * extension filter.
 */
import { statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import chokidar from "chokidar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_CLOUD_SYNC_EXCLUDED_DIR_NAMES,
	isIgnoredCloudSyncWatchPath,
} from "./cloudSyncWiring";

const excluded = new Set(DEFAULT_CLOUD_SYNC_EXCLUDED_DIR_NAMES);

let workspaceRoot: string;

beforeEach(async () => {
	workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-sync-watch-"));
});

afterEach(async () => {
	await fs.rm(workspaceRoot, { recursive: true, force: true });
});

function ignored(abs: string, statsArg?: "file" | "dir" | "none") {
	const stats =
		statsArg === "none"
			? undefined
			: statsArg === "dir"
				? statSync(path.dirname(abs) === abs ? abs : workspaceRoot)
				: statSync(abs);
	return isIgnoredCloudSyncWatchPath(abs, workspaceRoot, excluded, stats);
}

async function writeFixture(rel: string, content = "x") {
	const abs = path.join(workspaceRoot, rel);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content);
	return abs;
}

describe("isIgnoredCloudSyncWatchPath (quit-hang fix)", () => {
	it("ignores non-Markdown files (the Pods-header case)", async () => {
		const header = await writeFixture("fe/apps/mobile/ios/Pods/boost/a.h", "h");
		const source = await writeFixture("fe/apps/mobile/App.ts", "ts");
		const image = await writeFixture("note.assets/shot.png", "png");
		expect(ignored(header)).toBe(true);
		expect(ignored(source)).toBe(true);
		// Image attachments are synced by the walk but must not each cost a
		// handle: attaching one always touches its Markdown note, whose event
		// wakes the sync that picks the image up. An image-only change waits
		// for the next document/remote/restart trigger instead of its own.
		expect(ignored(image)).toBe(true);
	});

	it("still watches Markdown documents (md/markdown/mdown, any case)", async () => {
		for (const name of ["todo.md", "spec.markdown", "old.mdown", "LOUD.MD"]) {
			const abs = await writeFixture(`notes/${name}`, "# hi");
			expect(ignored(abs)).toBe(false);
		}
	});

	it("keeps directories walkable so nested notes stay synced", async () => {
		const nested = await writeFixture("fe/apps/mobile/notes/deep.md", "# d");
		await writeFixture("fe/apps/mobile/ios/Pods/boost/a.h", "h");
		// Every ancestor dir of the real note must NOT be ignored, or chokidar
		// prunes the whole subtree and the nested note silently stops syncing.
		for (const dir of [
			"fe",
			"fe/apps",
			"fe/apps/mobile",
			"fe/apps/mobile/notes",
			"fe/apps/mobile/ios",
		]) {
			expect(ignored(path.join(workspaceRoot, dir), "dir")).toBe(false);
		}
		expect(ignored(nested)).toBe(false);
	});

	it("prunes Pods entirely (Round 2 exclude-list addition, 2026-09-18)", async () => {
		// `Pods` joined DEFAULT_CLOUD_SYNC_EXCLUDED_DIR_NAMES after this test file
		// was written — CocoaPods vendored headers are never authored notes, and
		// excluding the whole subtree (not just filtering its files by
		// extension) removes both the file AND directory handles under it.
		const header = await writeFixture("fe/apps/mobile/ios/Pods/boost/a.h", "h");
		expect(
			ignored(path.join(workspaceRoot, "fe/apps/mobile/ios/Pods"), "dir"),
		).toBe(true);
		expect(ignored(header)).toBe(true);
	});

	it("keeps the sidecar exception behaving as before", async () => {
		const comments = await writeFixture(".mdly/comments/note.jsonl", "{}\n");
		const index = await writeFixture(".mdly/history/index.jsonl", "{}\n");
		const blob = await writeFixture(".mdly/history/objects/ab/cd", "b");
		const config = await writeFixture(".mdly/config.json", "{}");
		expect(ignored(comments)).toBe(false);
		expect(ignored(index)).toBe(false);
		// Revision blobs and sidecar-adjacent files still fall through to
		// the prune list and stay unwatched.
		expect(ignored(blob)).toBe(true);
		expect(ignored(config)).toBe(true);
		for (const dir of [".mdly", ".mdly/comments", ".mdly/history"]) {
			expect(ignored(path.join(workspaceRoot, dir), "dir")).toBe(false);
		}
	});

	it("keeps the prune list intact, even for Markdown files", async () => {
		const prunedNote = await writeFixture("node_modules/pkg/readme.md", "# x");
		expect(ignored(prunedNote)).toBe(true);
		const vendorNote = await writeFixture("vendor/lib.md", "# v");
		expect(
			isIgnoredCloudSyncWatchPath(
				vendorNote,
				workspaceRoot,
				["vendor"],
				statSync(vendorNote),
			),
		).toBe(true);
	});

	it("stays conservative without stats (never prune what it cannot see)", async () => {
		const abs = await writeFixture("fe/app.ts", "ts");
		expect(ignored(abs, "none")).toBe(false);
		// A stat-less directory-looking path must also stay walkable.
		expect(ignored(path.join(workspaceRoot, "fe"), "none")).toBe(false);
	});

	it("watches through a real chokidar instance: nested md fires, txt costs no handle", async () => {
		await writeFixture("nested/note.md", "# hello");
		await writeFixture("nested/ignore.txt", "nope");
		await writeFixture("top.h", "nope");
		const watcher = chokidar.watch(workspaceRoot, {
			ignoreInitial: true,
			ignored: (candidatePath: string, stats?: import("node:fs").Stats) =>
				isIgnoredCloudSyncWatchPath(
					candidatePath,
					workspaceRoot,
					excluded,
					stats,
				),
		});
		try {
			await vi.waitFor(
				() =>
					expect(
						Object.values(watcher.getWatched()).some((files) =>
							files.includes("note.md"),
						),
					).toBe(true),
				{ timeout: 15000 },
			);
			const watchedFiles = Object.values(watcher.getWatched()).flat();
			expect(watchedFiles).toContain("note.md");
			expect(watchedFiles).not.toContain("ignore.txt");
			expect(watchedFiles).not.toContain("top.h");
			// The nested directory was traversed (not pruned): an edit to the
			// nested note still wakes the watcher.
			const changed = new Promise<string>((resolve) =>
				watcher.on("change", resolve),
			);
			await fs.writeFile(
				path.join(workspaceRoot, "nested/note.md"),
				"# edited",
			);
			await expect(changed).resolves.toContain("note.md");
		} finally {
			await watcher.close();
		}
	}, 30000);
});
