/**
 * Core sync-mechanics coverage for Phase 1 Cloud Sync (charter R19-R30):
 * the prune list, off-by-default, per-workspace persistence, and the 250ms
 * debounce. Reliability/failure-mode coverage (R20-R25) lives in the sibling
 * `cloudSyncWiring.reliability.test.ts` — split purely to keep each file
 * under the project's ~700-LOC refactor-trigger guideline; both share the
 * test doubles in `cloudSyncTestDoubles.ts`.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FSWatcher } from "chokidar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFakeBackend,
	createFakeKeychain,
	createFakeSubscriber,
	createFakeWorkspaceDeleter,
	waitFor,
	writeCloudSyncConfigFixture,
} from "./cloudSyncTestDoubles";
import {
	DEFAULT_CLOUD_SYNC_EXCLUDED_DIR_NAMES,
	disableCloudSyncForWorkspace,
	effectiveExcludedFolders,
	enableCloudSyncForWorkspace,
	isCloudSyncRunning,
	isPrunedCloudSyncPath,
	normalizeExcludedFolders,
	readCloudSyncWorkspaceState,
	resumeCloudSyncForGrantedRoots,
	retryPendingCloudSyncDeletions,
	SHARED_CLOUD_SYNC_ACCOUNT,
	setCloudSyncExcludedFolders,
	startCloudSyncWatcherIfEnabled,
	stopAllCloudSync,
} from "./cloudSyncWiring";
import { createSelfWriteEchoTracker } from "./docHistoryWiring";

let workspaceRoot: string;
let extraTmpDirs: string[];

beforeEach(async () => {
	workspaceRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "cloud-sync-wiring-"),
	);
	extraTmpDirs = [];
});

afterEach(async () => {
	await stopAllCloudSync();
	await fs.rm(workspaceRoot, { recursive: true, force: true });
	for (const dir of extraTmpDirs)
		await fs.rm(dir, { recursive: true, force: true });
});

describe("isPrunedCloudSyncPath (R19)", () => {
	it("prunes .git, node_modules, dist, .dev-electron, .hubble, and .mdly", () => {
		for (const dir of [
			".git",
			"node_modules",
			"dist",
			".dev-electron",
			".hubble",
			".mdly",
		]) {
			expect(isPrunedCloudSyncPath(`/ws/${dir}/file.md`, "/ws")).toBe(true);
		}
	});

	it("prunes .claude, whose agent worktrees hold tens of thousands of files", () => {
		expect(isPrunedCloudSyncPath("/ws/.claude/settings.json", "/ws")).toBe(
			true,
		);
	});

	it("prunes a deeply nested file inside an agent worktree, not just the top level", () => {
		expect(
			isPrunedCloudSyncPath("/ws/.claude/worktrees/x/src/a.md", "/ws"),
		).toBe(true);
	});

	it("does not prune an ordinary nested note", () => {
		expect(isPrunedCloudSyncPath("/ws/notes/todo.md", "/ws")).toBe(false);
	});

	it("a configured list REPLACES the defaults — a default name left out of it is no longer pruned", () => {
		const custom = [".claude", "vendor"];
		expect(
			isPrunedCloudSyncPath("/ws/.claude/worktrees/x/a.md", "/ws", custom),
		).toBe(true);
		expect(isPrunedCloudSyncPath("/ws/vendor/lib.md", "/ws", custom)).toBe(
			true,
		);
		// "node_modules" is a built-in default but is absent from `custom`.
		expect(
			isPrunedCloudSyncPath("/ws/node_modules/pkg/readme.md", "/ws", custom),
		).toBe(false);
	});

	it("an anchored entry prunes only that workspace-relative path, not the same name elsewhere", () => {
		const custom = ["fe/docs"];
		expect(isPrunedCloudSyncPath("/ws/fe/docs/a.md", "/ws", custom)).toBe(
			true,
		);
		expect(
			isPrunedCloudSyncPath("/ws/fe/docs/nested/b.md", "/ws", custom),
		).toBe(true);
		// Same folder name at a different path is NOT pruned.
		expect(isPrunedCloudSyncPath("/ws/docs/a.md", "/ws", custom)).toBe(false);
		expect(isPrunedCloudSyncPath("/ws/other/fe/docs/a.md", "/ws", custom)).toBe(
			false,
		);
		// While a bare name still matches at any depth.
		expect(isPrunedCloudSyncPath("/ws/a/docs/b.md", "/ws", ["docs"])).toBe(
			true,
		);
	});

	it("a leading slash anchors to the root (gitignore meaning)", () => {
		expect(isPrunedCloudSyncPath("/ws/dist/a.md", "/ws", ["/dist"])).toBe(
			true,
		);
		expect(isPrunedCloudSyncPath("/ws/a/dist/b.md", "/ws", ["/dist"])).toBe(
			false,
		);
	});
});

describe("effectiveExcludedFolders", () => {
	it("an absent excludedFolders means the built-in defaults, not 'exclude nothing'", () => {
		expect(effectiveExcludedFolders(undefined)).toEqual(
			DEFAULT_CLOUD_SYNC_EXCLUDED_DIR_NAMES,
		);
		expect(effectiveExcludedFolders({})).toEqual(
			DEFAULT_CLOUD_SYNC_EXCLUDED_DIR_NAMES,
		);
		expect(DEFAULT_CLOUD_SYNC_EXCLUDED_DIR_NAMES).toContain(".claude");
	});

	it("a configured list wins wholesale, including the deliberately empty one", () => {
		expect(effectiveExcludedFolders({ excludedFolders: ["vendor"] })).toEqual([
			"vendor",
		]);
		expect(effectiveExcludedFolders({ excludedFolders: [] })).toEqual([]);
	});
});

describe("normalizeExcludedFolders", () => {
	it("trims, drops blanks, de-duplicates, and preserves order", () => {
		expect(
			normalizeExcludedFolders([
				"  .claude ",
				"",
				"   ",
				"node_modules",
				".claude",
				"vendor",
			]),
		).toEqual([".claude", "node_modules", "vendor"]);
	});

	it("allows an empty result — that legitimately means 'sync everything'", () => {
		expect(normalizeExcludedFolders(["", "  "])).toEqual([]);
	});

	it("accepts workspace-anchored paths (gitignore convention) and preserves leading-slash anchors", () => {
		expect(
			normalizeExcludedFolders(["notes/drafts", "/fe/docs/", "notes\\drafts"]),
		).toEqual(["notes/drafts", "/fe/docs"]);
		expect(normalizeExcludedFolders(["/dist"])).toEqual(["/dist"]);
	});

	it("rejects entries that escape the workspace or are empty segments", () => {
		expect(() => normalizeExcludedFolders(["../escape"])).toThrow(
			/not a valid exclusion/i,
		);
		expect(() => normalizeExcludedFolders(["a//b"])).toThrow(
			/not a valid exclusion/i,
		);
	});
});

describe("setCloudSyncExcludedFolders", () => {
	async function readRawConfig(root: string) {
		return JSON.parse(
			await fs.readFile(path.join(root, ".hubble", "config.json"), "utf8"),
		);
	}

	function depsFor() {
		const { backend } = createFakeBackend();
		const { subscriber } = createFakeSubscriber();
		return {
			echoTracker: createSelfWriteEchoTracker(),
			grantedRoots: [workspaceRoot],
			keychain: createFakeKeychain({ [SHARED_CLOUD_SYNC_ACCOUNT]: "pw" }),
			createBackend: () => backend,
			createSubscriber: () => subscriber,
			debounceMs: 20,
		};
	}

	it("persists the normalized list and reports it as the effective one", async () => {
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: false,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});

		const state = await setCloudSyncExcludedFolders(
			workspaceRoot,
			[" .claude", "vendor", "", "vendor"],
			depsFor(),
		);

		expect(state.excludedFolders).toEqual([".claude", "vendor"]);
		const raw = await readRawConfig(workspaceRoot);
		expect(raw.cloudSync.excludedFolders).toEqual([".claude", "vendor"]);
		const reread = await readCloudSyncWorkspaceState(workspaceRoot);
		expect(reread.excludedFolders).toEqual([".claude", "vendor"]);
	});

	it("persists a workspace-anchored path entry (selection UIs produce paths)", async () => {
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: false,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});

		const state = await setCloudSyncExcludedFolders(
			workspaceRoot,
			[".claude", "notes/drafts"],
			depsFor(),
		);

		expect(state.excludedFolders).toEqual([".claude", "notes/drafts"]);
		const raw = await readRawConfig(workspaceRoot);
		expect(raw.cloudSync.excludedFolders).toEqual([
			".claude",
			"notes/drafts",
		]);
	});

	it("rejects a workspace-escaping entry and writes NOTHING to the config", async () => {
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: false,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});
		const before = await readRawConfig(workspaceRoot);

		await expect(
			setCloudSyncExcludedFolders(
				workspaceRoot,
				[".claude", "../escape"],
				depsFor(),
			),
		).rejects.toThrow(/not a valid exclusion/i);

		expect(await readRawConfig(workspaceRoot)).toEqual(before);
		expect(
			(await readCloudSyncWorkspaceState(workspaceRoot)).excludedFolders,
		).toEqual([...DEFAULT_CLOUD_SYNC_EXCLUDED_DIR_NAMES]);
	});

	it("round-trips .hubble/config.json without losing unrelated top-level keys (the schema's .passthrough() contract)", async () => {
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: false,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});
		const withDesktopKeys = {
			...(await readRawConfig(workspaceRoot)),
			version: 1,
			pinnedNotes: ["notes/todo.md"],
		};
		await fs.writeFile(
			path.join(workspaceRoot, ".hubble", "config.json"),
			JSON.stringify(withDesktopKeys, null, "\t"),
		);

		await setCloudSyncExcludedFolders(workspaceRoot, ["vendor"], depsFor());

		const after = await readRawConfig(workspaceRoot);
		expect(after.version).toBe(1);
		expect(after.pinnedNotes).toEqual(["notes/todo.md"]);
		expect(after.cloudSync.excludedFolders).toEqual(["vendor"]);
		expect(after.cloudSync.workspaceId).toBe("ws-1");
	});
});

describe("cloud sync off by default (R26)", () => {
	it("a file write triggers zero backend calls while disabled", async () => {
		await fs.writeFile(path.join(workspaceRoot, "note.md"), "hello");
		const { backend, calls } = createFakeBackend();
		const { subscriber } = createFakeSubscriber();
		const deps = {
			echoTracker: createSelfWriteEchoTracker(),
			grantedRoots: [workspaceRoot],
			keychain: createFakeKeychain(),
			createBackend: () => backend,
			createSubscriber: () => subscriber,
			debounceMs: 20,
		};

		const state = await startCloudSyncWatcherIfEnabled(workspaceRoot, deps);
		expect(state.status).toBe("off");
		expect(state.backgroundSync).toBe(false);
		expect(isCloudSyncRunning(workspaceRoot)).toBe(false);

		await fs.writeFile(path.join(workspaceRoot, "note.md"), "changed");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(calls.pushFile).toHaveLength(0);
		expect(calls.getFiles).toBe(0);
	});

	it("flipping the toggle on makes pushFile get called", async () => {
		await fs.writeFile(path.join(workspaceRoot, "note.md"), "hello");
		const { backend, calls } = createFakeBackend();
		const { subscriber } = createFakeSubscriber();
		const keychain = createFakeKeychain();
		const deps = {
			echoTracker: createSelfWriteEchoTracker(),
			grantedRoots: [workspaceRoot],
			keychain,
			createBackend: () => backend,
			createSubscriber: () => subscriber,
			debounceMs: 20,
		};

		const state = await enableCloudSyncForWorkspace(
			{
				workspaceRoot,
				workspaceName: "test-workspace",
				deploymentUrl: "http://127.0.0.1:8787",
				password: "shared-password",
			},
			deps,
		);

		expect(state.backgroundSync).toBe(true);
		expect(calls.pushFile).toContain("note.md");
		expect(keychain.calls.setPassword).toBe(1);
	});
});

describe("per-workspace persistence (R27)", () => {
	it("the toggle persists on disk and a fresh read (no running watcher) reflects it", async () => {
		await fs.writeFile(path.join(workspaceRoot, "note.md"), "hello");
		const { backend } = createFakeBackend();
		const { subscriber } = createFakeSubscriber();
		const deps = {
			echoTracker: createSelfWriteEchoTracker(),
			grantedRoots: [workspaceRoot],
			keychain: createFakeKeychain(),
			createBackend: () => backend,
			createSubscriber: () => subscriber,
			debounceMs: 20,
		};

		await enableCloudSyncForWorkspace(
			{
				workspaceRoot,
				workspaceName: "test-workspace",
				deploymentUrl: "http://127.0.0.1:8787",
				password: "shared-password",
			},
			deps,
		);
		await stopAllCloudSync();

		const persisted = await readCloudSyncWorkspaceState(workspaceRoot);
		expect(persisted.backgroundSync).toBe(true);
		expect(persisted.workspaceId).toBe("ws-1");
	});

	it("turning it back off persists false and stops the watcher", async () => {
		const { backend } = createFakeBackend();
		const { subscriber } = createFakeSubscriber();
		const deleter = createFakeWorkspaceDeleter();
		const deps = {
			echoTracker: createSelfWriteEchoTracker(),
			grantedRoots: [workspaceRoot],
			keychain: createFakeKeychain(),
			createBackend: () => backend,
			createSubscriber: () => subscriber,
			deleteWorkspaceRemote: deleter.deleteWorkspaceRemote,
			debounceMs: 20,
		};
		await enableCloudSyncForWorkspace(
			{
				workspaceRoot,
				workspaceName: "test-workspace",
				deploymentUrl: "http://127.0.0.1:8787",
				password: "shared-password",
			},
			deps,
		);
		expect(isCloudSyncRunning(workspaceRoot)).toBe(true);

		const result = await disableCloudSyncForWorkspace(workspaceRoot, deps);
		expect(isCloudSyncRunning(workspaceRoot)).toBe(false);
		const persisted = await readCloudSyncWorkspaceState(workspaceRoot);
		expect(persisted.backgroundSync).toBe(false);

		// R36: the off-switch actually triggered the remote delete, and it
		// reported success honestly.
		expect(deleter.calls).toHaveLength(1);
		expect(deleter.calls[0]?.workspaceId).toBe("ws-1");
		expect(result.cloudCopyDeleted).toBe(true);
		expect(persisted.status).toBe("off");
	});

	it("resumeCloudSyncForGrantedRoots starts only the enabled roots, isolating each root's outcome", async () => {
		const rootB = await fs.mkdtemp(
			path.join(os.tmpdir(), "cloud-sync-wiring-b-"),
		);
		extraTmpDirs.push(rootB);
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: true,
			workspaceId: "ws-a",
			deploymentUrl: "http://127.0.0.1:8787",
		});
		await writeCloudSyncConfigFixture(rootB, {
			backgroundSync: false,
			workspaceId: "ws-b",
			deploymentUrl: "http://127.0.0.1:8787",
		});
		const { backend } = createFakeBackend();
		const { subscriber } = createFakeSubscriber();
		const deps = {
			echoTracker: createSelfWriteEchoTracker(),
			grantedRoots: [workspaceRoot, rootB],
			keychain: createFakeKeychain({ [SHARED_CLOUD_SYNC_ACCOUNT]: "pw" }),
			createBackend: () => backend,
			createSubscriber: () => subscriber,
			debounceMs: 20,
		};

		await resumeCloudSyncForGrantedRoots([workspaceRoot, rootB], deps);
		expect(isCloudSyncRunning(workspaceRoot)).toBe(true);
		expect(isCloudSyncRunning(rootB)).toBe(false);
	});
});

describe("R36 — turning cloud sync off deletes the workspace's cloud copy honestly", () => {
	it("when the remote delete fails, local sync still goes off immediately but the state reports the cloud copy as NOT removed, never claiming success", async () => {
		const { backend } = createFakeBackend();
		const { subscriber } = createFakeSubscriber();
		const deleter = createFakeWorkspaceDeleter(false); // simulates offline/401
		const deps = {
			echoTracker: createSelfWriteEchoTracker(),
			grantedRoots: [workspaceRoot],
			keychain: createFakeKeychain(),
			createBackend: () => backend,
			createSubscriber: () => subscriber,
			deleteWorkspaceRemote: deleter.deleteWorkspaceRemote,
			debounceMs: 20,
		};
		await enableCloudSyncForWorkspace(
			{
				workspaceRoot,
				workspaceName: "test-workspace",
				deploymentUrl: "http://127.0.0.1:8787",
				password: "shared-password",
			},
			deps,
		);

		const result = await disableCloudSyncForWorkspace(workspaceRoot, deps);

		// R27 still holds unconditionally: the watcher stopped and local sync
		// is off, regardless of the network outcome.
		expect(isCloudSyncRunning(workspaceRoot)).toBe(false);
		const persisted = await readCloudSyncWorkspaceState(workspaceRoot);
		expect(persisted.backgroundSync).toBe(false);

		// But the honesty contract: never report "deleted" when nothing was.
		expect(result.cloudCopyDeleted).toBe(false);
		expect(persisted.status).not.toBe("off");
		expect(persisted.detail).toMatch(/not been removed yet/i);
	});

	it("retryPendingCloudSyncDeletions finishes the job on a later launch once the backend is reachable again", async () => {
		const { backend } = createFakeBackend();
		const { subscriber } = createFakeSubscriber();
		const failingDeleter = createFakeWorkspaceDeleter(false);
		const deps = {
			echoTracker: createSelfWriteEchoTracker(),
			grantedRoots: [workspaceRoot],
			keychain: createFakeKeychain(),
			createBackend: () => backend,
			createSubscriber: () => subscriber,
			deleteWorkspaceRemote: failingDeleter.deleteWorkspaceRemote,
			debounceMs: 20,
		};
		await enableCloudSyncForWorkspace(
			{
				workspaceRoot,
				workspaceName: "test-workspace",
				deploymentUrl: "http://127.0.0.1:8787",
				password: "shared-password",
			},
			deps,
		);
		await disableCloudSyncForWorkspace(workspaceRoot, deps);
		const afterFailedDisable = await readCloudSyncWorkspaceState(workspaceRoot);
		expect(afterFailedDisable.status).not.toBe("off");

		// "Next launch": the backend is reachable now.
		const succeedingDeleter = createFakeWorkspaceDeleter(true);
		await retryPendingCloudSyncDeletions([workspaceRoot], {
			...deps,
			deleteWorkspaceRemote: succeedingDeleter.deleteWorkspaceRemote,
		});

		expect(succeedingDeleter.calls).toHaveLength(1);
		const afterRetry = await readCloudSyncWorkspaceState(workspaceRoot);
		expect(afterRetry.status).toBe("off");
		expect(afterRetry.detail).toBeNull();

		// A further retry pass finds nothing pending and makes no more calls.
		await retryPendingCloudSyncDeletions([workspaceRoot], {
			...deps,
			deleteWorkspaceRemote: succeedingDeleter.deleteWorkspaceRemote,
		});
		expect(succeedingDeleter.calls).toHaveLength(1);
	});
});

describe("250ms debounce (R19)", () => {
	it("collapses a burst of writes into exactly one sync run", async () => {
		// Deterministic by construction: an injected fake watcher emits all
		// five events synchronously (no fs-timing in delivery), and fake
		// timers collapse them through ONE 250ms debounce window. Real time
		// is used only as a generous completion window for the tiny sync
		// itself — never as a race window. (The old all-real version failed
		// ~1 in 8 runs under load. Pure-virtual time was tried: it starves
		// real fs I/O inside plan/execute, so the run never completes.)
		const { backend, calls } = createFakeBackend();
		const { subscriber } = createFakeSubscriber();
		const listeners = new Map<string, Set<(payload?: string) => void>>();
		const fakeWatcher = {
			on(event: string, callback: (payload?: string) => void) {
				let set = listeners.get(event);
				if (!set) {
					set = new Set();
					listeners.set(event, set);
				}
				set.add(callback);
				return this;
			},
			async close() {},
		} as unknown as FSWatcher;
		const deps = {
			echoTracker: createSelfWriteEchoTracker(),
			grantedRoots: [workspaceRoot],
			keychain: createFakeKeychain({ [SHARED_CLOUD_SYNC_ACCOUNT]: "pw" }),
			createBackend: () => backend,
			createSubscriber: () => subscriber,
			createWatcher: () => fakeWatcher,
			// deliberately NOT overriding debounceMs — this proves the real 250ms default (R19).
		};
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: true,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});

		await startCloudSyncWatcherIfEnabled(workspaceRoot, deps);
		const callsBeforeBurst = calls.getFiles;

		vi.useFakeTimers();
		try {
			for (let i = 0; i < 5; i++) {
				await fs.writeFile(
					path.join(workspaceRoot, `burst-${i}.md`),
					`content ${i}`,
				);
				for (const callback of listeners.get("add") ?? [])
					callback(path.join(workspaceRoot, `burst-${i}.md`));
			}
			// Exactly one debounce window fires for all five events.
			await vi.advanceTimersByTimeAsync(300);
		} finally {
			vi.useRealTimers();
		}

		// Generous real-time completion window for the 5-file sync.
		await waitFor(() => calls.getFiles - callsBeforeBurst === 2, 10000);
		// One run = two manifest fetches (plan() decides, execute() re-reads
		// for pulls/conflicts so a stale preview can never clobber fresh
		// remote edits). Five writes collapsing to 2 fetches still proves a
		// single run — without coalescing it would be five runs / ten fetches.
		expect(calls.pushFile.filter((p) => p.startsWith("burst-")).length).toBe(
			5,
		);
		// Quiet settles nothing more: no events, no timers, no runs.
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(calls.getFiles - callsBeforeBurst).toBe(2);
	});
});
