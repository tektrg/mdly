/**
 * Coverage for the quit-hang structural fix (round 3, 2026-09-18):
 * `createRecursiveFsWatcher` replaces chokidar's thousands-of-handles watcher
 * with a single `fs.watch(root, {recursive:true})` subscription, then
 * reconstructs chokidar's add/change/unlink/addDir/unlinkDir vocabulary from
 * Node's coarser raw `(eventType, filename)` callback via `stat()`. Follows
 * the same real-instance-plus-`vi.waitFor` style as
 * `cloudSyncWiring.watchFilter.test.ts`'s real-chokidar test — a native
 * recursive watch has the same "give it a moment" characteristics as
 * chokidar's own initial scan, so a fixed sleep would be exactly the kind of
 * flake documented in `cloudSyncWiring.reliability.test.ts`.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CloudSyncWatcher,
	createRecursiveFsWatcher,
	DEFAULT_CLOUD_SYNC_EXCLUDED_DIR_NAMES,
} from "./cloudSyncWiring";

let workspaceRoot: string;

beforeEach(async () => {
	workspaceRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "cloud-sync-recursive-watch-"),
	);
});

afterEach(async () => {
	await fs.rm(workspaceRoot, { recursive: true, force: true });
});

async function writeFixture(rel: string, content = "x") {
	const abs = path.join(workspaceRoot, rel);
	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, content);
	return abs;
}

/**
 * `fs.watch(root, {recursive:true})` has a brief kernel-side setup window
 * before its FSEvents stream is actually live — chokidar's own equivalent is
 * why `cloudSyncWiring.watchFilter.test.ts`'s real-instance test waits for
 * `getWatched()` before touching the fixture. A native `fs.watch` handle
 * exposes no such "ready" signal, so instead of a fixed sleep (irrelevant in
 * production, since Cloud Sync runs for the life of the app — but a real,
 * reproducible flake under CI load here, the exact pattern already found and
 * fixed once in `cloudSyncWiring.reliability.test.ts` this same round) this
 * polls with a real write+delete probe until an `unlink` event for it is
 * actually observed, retrying if the stream wasn't live yet.
 */
async function waitUntilWatcherIsLive(
	watcher: CloudSyncWatcher,
	root: string,
): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt++) {
		const probePath = path.join(
			root,
			`.watch-ready-probe-${attempt}-${Date.now()}.md`,
		);
		const seen = await new Promise<boolean>((resolve) => {
			let settled = false;
			watcher.on("unlink", (p) => {
				if (!settled && p === probePath) {
					settled = true;
					resolve(true);
				}
			});
			void (async () => {
				await fs.writeFile(probePath, "probe");
				await fs.rm(probePath);
			})();
			setTimeout(() => {
				if (!settled) resolve(false);
			}, 300);
		});
		if (seen) return;
	}
	throw new Error("recursive fs.watch never became live for probing");
}

describe("createRecursiveFsWatcher (quit-hang fix, round 3)", () => {
	it("reconstructs change/addDir/unlink from one native handle, and filters non-documents the same as fix #2", async () => {
		const watcher = createRecursiveFsWatcher(
			workspaceRoot,
			DEFAULT_CLOUD_SYNC_EXCLUDED_DIR_NAMES,
		);
		const changed: string[] = [];
		const addedDirs: string[] = [];
		const unlinked: string[] = [];
		watcher.on("change", (p) => p && changed.push(p));
		watcher.on("add", (p) => p && changed.push(p));
		watcher.on("addDir", (p) => p && addedDirs.push(p));
		watcher.on("unlink", (p) => p && unlinked.push(p));
		try {
			await waitUntilWatcherIsLive(watcher, workspaceRoot);
			const notePath = await writeFixture("nested/note.md", "# hello");
			await writeFixture("nested/ignore.txt", "nope");
			// A directory-only creation (no file inside yet) must still surface
			// as `addDir` — that's what the "unvetted worktree" vetting logic
			// keys off of for a brand-new top-level folder.
			await fs.mkdir(path.join(workspaceRoot, "another-dir"));

			await vi.waitFor(
				() => {
					expect(changed).toContain(notePath);
					expect(addedDirs.some((d) => d.endsWith("another-dir"))).toBe(true);
				},
				{ timeout: 15000 },
			);
			expect(changed.some((p) => p.endsWith("ignore.txt"))).toBe(false);

			await fs.rm(notePath);
			await vi.waitFor(() => expect(unlinked).toContain(notePath), {
				timeout: 15000,
			});

			// A removed DIRECTORY must also surface as `unlink`, not a bare
			// `unlinkDir` trigger: `onFileEvent` (bound to `unlink`) refreshes
			// the "known top" vetting bookkeeping that the bare trigger skips,
			// so mapping a directory's ENOENT to `unlink` is a strict superset
			// of chokidar's real `unlinkDir` — never a regression, per the plan.
			const removedDirPath = path.join(workspaceRoot, "another-dir");
			await fs.rm(removedDirPath, { recursive: true });
			await vi.waitFor(() => expect(unlinked).toContain(removedDirPath), {
				timeout: 15000,
			});
		} finally {
			await watcher.close();
		}
	}, 30000);

	it("never dispatches for pruned subtrees (node_modules) even though the recursive handle covers them", async () => {
		const watcher = createRecursiveFsWatcher(
			workspaceRoot,
			DEFAULT_CLOUD_SYNC_EXCLUDED_DIR_NAMES,
		);
		const anyEvent: string[] = [];
		for (const event of ["add", "change", "addDir", "unlink"] as const) {
			watcher.on(event, (p) => p && anyEvent.push(p));
		}
		try {
			await waitUntilWatcherIsLive(watcher, workspaceRoot);
			const controlNote = await writeFixture("real/note.md", "# real");
			await writeFixture("node_modules/pkg/readme.md", "# never");
			await vi.waitFor(() => expect(anyEvent).toContain(controlNote), {
				timeout: 15000,
			});
			// Give a pruned-path event every chance it would have had by now.
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(anyEvent.some((p) => p.includes("node_modules"))).toBe(false);
		} finally {
			await watcher.close();
		}
	}, 30000);

	it("keeps the .mdly sidecar exception working through the real adapter", async () => {
		const watcher = createRecursiveFsWatcher(
			workspaceRoot,
			DEFAULT_CLOUD_SYNC_EXCLUDED_DIR_NAMES,
		);
		const anyEvent: string[] = [];
		for (const event of ["add", "change", "addDir", "unlink"] as const) {
			watcher.on(event, (p) => p && anyEvent.push(p));
		}
		try {
			await waitUntilWatcherIsLive(watcher, workspaceRoot);
			const index = await writeFixture(".mdly/history/index.jsonl", "{}\n");
			await vi.waitFor(() => expect(anyEvent).toContain(index), {
				timeout: 15000,
			});
			await writeFixture(".mdly/history/objects/ab/cd", "blob");
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(anyEvent.some((p) => p.includes("objects"))).toBe(false);
		} finally {
			await watcher.close();
		}
	}, 30000);

	it("close() resolves promptly — the entire point of the quit-hang fix", async () => {
		const watcher = createRecursiveFsWatcher(
			workspaceRoot,
			DEFAULT_CLOUD_SYNC_EXCLUDED_DIR_NAMES,
		);
		const start = Date.now();
		await watcher.close();
		// One native handle, not thousands: this used to take minutes on a
		// real workspace (see the round-1/round-2 memory note). A generous
		// bound here, not a tight perf assertion — the point is "doesn't hang".
		expect(Date.now() - start).toBeLessThan(2000);
	});
});
