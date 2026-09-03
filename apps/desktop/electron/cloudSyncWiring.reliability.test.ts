/**
 * Reliability/failure-mode coverage for Phase 1 Cloud Sync (charter
 * R20-R25, plus the Stage 1 password-rotation flag): the shared echo
 * tracker, delete-history routing, no leaked subscriptions/watchers,
 * Keychain-only credential storage, visible re-authentication, and graceful
 * degradation when a workspace folder disappears. Core sync-mechanics
 * coverage (R19, R26, R27) lives in the sibling `cloudSyncWiring.test.ts` —
 * split purely to keep each file under the project's ~700-LOC
 * refactor-trigger guideline; both share the test doubles in
 * `cloudSyncTestDoubles.ts`.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeSyncState } from "@hubble.md/sync";
import {
	createNodeFileSystem,
	WorkspaceTraversalLimitError,
} from "@hubble.md/sync/node";
import { CloudflareResponseError } from "@mdly/cloudflare-client";
import { contentHash } from "@mdly/doc-history";
import type { FSWatcher } from "chokidar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFakeBackend,
	createFakeKeychain,
	createFakeSubscriber,
	createFakeWorkspaceDeleter,
	pathExists,
	waitFor,
	writeCloudSyncConfigFixture,
} from "./cloudSyncTestDoubles";
import {
	activeCloudSyncWorkspaceCount,
	type CloudSyncStatus,
	disableCloudSyncForWorkspace,
	enableCloudSyncForWorkspace,
	getCloudSyncStatus,
	isCloudSyncRunning,
	onCloudSyncStatusChange,
	SHARED_CLOUD_SYNC_ACCOUNT,
	setCloudSyncExcludedFolders,
	startCloudSyncWatcherIfEnabled,
	stopAllCloudSync,
	stopCloudSyncForWorkspace,
} from "./cloudSyncWiring";
import {
	createSelfWriteEchoTracker,
	getHistoryStoreForWorkspace,
	recordExternalWriteHistory,
} from "./docHistoryWiring";

let workspaceRoot: string;

beforeEach(async () => {
	workspaceRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "cloud-sync-wiring-"),
	);
});

afterEach(async () => {
	await stopAllCloudSync();
	await fs.rm(workspaceRoot, { recursive: true, force: true });
});

describe("cloud pull vs. the shared echo tracker (R21)", () => {
	it("a pulled write is recorded on the SAME tracker instance handed in via deps, and the active-file watcher's own hook then skips it", async () => {
		const relativePath = "pulled.md";
		const remoteContent = "pulled from another Mac";
		const remoteHash = await contentHash(
			new TextEncoder().encode(remoteContent),
		);
		const { backend, calls } = createFakeBackend([
			{
				path: relativePath,
				contentHash: remoteHash,
				content: remoteContent,
				deviceId: "other-device",
				deleted: false,
				updatedAt: Date.now(),
			},
		]);
		const { subscriber } = createFakeSubscriber();
		const echoTracker = createSelfWriteEchoTracker();
		const deps = {
			echoTracker,
			grantedRoots: [workspaceRoot],
			keychain: createFakeKeychain({ [SHARED_CLOUD_SYNC_ACCOUNT]: "pw" }),
			createBackend: () => backend,
			createSubscriber: () => subscriber,
			debounceMs: 20,
		};
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: true,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});

		await startCloudSyncWatcherIfEnabled(workspaceRoot, deps);
		const absolutePath = path.resolve(path.join(workspaceRoot, relativePath));
		await waitFor(() => pathExists(absolutePath));
		await expect(fs.readFile(absolutePath, "utf8")).resolves.toBe(
			remoteContent,
		);

		// R21's actual mechanism: the SAME echoTracker instance we injected now
		// recognizes this exact write as its own — not a second, private instance.
		expect(echoTracker.matches(absolutePath, remoteHash)).toBe(true);

		// This is exactly what main.ts's existing active-file watcher calls when
		// it independently observes this same write on disk.
		await recordExternalWriteHistory({
			absoluteFilePath: absolutePath,
			grantedRoots: [workspaceRoot],
			echoTracker,
		});
		expect(await pathExists(path.join(workspaceRoot, ".mdly", "history"))).toBe(
			false,
		);

		// R21's other half: our own watcher noticing the pull's own disk write
		// must not push the pulled content back up.
		const pushesBeforeWait = calls.pushFile.length;
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(calls.pushFile).toHaveLength(pushesBeforeWait);
	}, 10000);

	it("uses a genuinely different tracker for an unrelated instance (negative control)", () => {
		const trackerA = createSelfWriteEchoTracker();
		const trackerB = createSelfWriteEchoTracker();
		trackerA.record("/ws/a.md", "hash-1");
		expect(trackerB.matches("/ws/a.md", "hash-1")).toBe(false);
	});
});

describe("remote deletion goes through delete-history (R22)", () => {
	it("a later, unrelated file at the same path never inherits the deleted document's history", async () => {
		const relativePath = "note.md";
		const absolutePath = path.join(workspaceRoot, relativePath);
		await fs.writeFile(absolutePath, "original content");
		const history = getHistoryStoreForWorkspace(workspaceRoot);
		await history.recordRevision(relativePath, "original content", {
			by: { kind: "human", id: "device-1" },
			cause: "manual",
		});
		const docIdBefore = (await history.resolveDocId(relativePath)).id;

		const originalHash = await contentHash(
			new TextEncoder().encode("original content"),
		);
		await writeSyncState(createNodeFileSystem(), workspaceRoot, {
			lastSyncedAt: Date.now(),
			files: {
				[relativePath]: { hash: originalHash, lastSyncedAt: Date.now() },
			},
		});
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: true,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});

		const { backend } = createFakeBackend([
			{
				path: relativePath,
				contentHash: originalHash,
				content: "original content",
				deviceId: "other-device",
				deleted: true,
				updatedAt: Date.now(),
			},
		]);
		const { subscriber } = createFakeSubscriber();
		const deps = {
			echoTracker: createSelfWriteEchoTracker(),
			grantedRoots: [workspaceRoot],
			keychain: createFakeKeychain({ [SHARED_CLOUD_SYNC_ACCOUNT]: "pw" }),
			createBackend: () => backend,
			createSubscriber: () => subscriber,
			debounceMs: 20,
		};

		await startCloudSyncWatcherIfEnabled(workspaceRoot, deps);
		await waitFor(async () => !(await pathExists(absolutePath)));
		// Stop the watcher before writing the next file directly to disk below:
		// this test's real chokidar watcher is still live at this point (this
		// `deps` never overrides `createWatcher`), and a raw `fs.writeFile` past
		// this line would otherwise itself get picked up and debounce-trigger
		// another real background sync cycle (`deps.debounceMs: 20`) racing the
		// assertions and `afterEach`'s tmp-dir cleanup below — unrelated to what
		// this test is actually checking (R22's delete -> history bookkeeping).
		await stopCloudSyncForWorkspace(workspaceRoot);

		// A brand-new, unrelated document written to the same path afterward.
		await fs.writeFile(absolutePath, "brand new content");
		const freshHistory = getHistoryStoreForWorkspace(workspaceRoot);
		await freshHistory.recordRevision(relativePath, "brand new content", {
			by: { kind: "human", id: "device-1" },
			cause: "manual",
		});
		const docIdAfter = (await freshHistory.resolveDocId(relativePath)).id;

		expect(docIdAfter).not.toBe(docIdBefore);
		const revisions = await freshHistory.getRevisionHistory(relativePath);
		expect(revisions).toHaveLength(1);
	}, 10000);
});

describe("no leaked subscription or duplicate watcher on repeated drop/restore (R25)", () => {
	it("5 simulated drop/restore cycles still leave exactly one subscriber and one watcher", async () => {
		const { backend } = createFakeBackend();
		const { subscriber, fireFilesChanged, getListenerCount } =
			createFakeSubscriber();
		let subscriberFactoryCalls = 0;
		let watcherFactoryCalls = 0;
		const fakeWatcher = {
			on: vi.fn(function (this: unknown) {
				return this;
			}),
			close: vi.fn(async () => {}),
		} as unknown as FSWatcher;
		const deps = {
			echoTracker: createSelfWriteEchoTracker(),
			grantedRoots: [workspaceRoot],
			keychain: createFakeKeychain({ [SHARED_CLOUD_SYNC_ACCOUNT]: "pw" }),
			createBackend: () => backend,
			createSubscriber: () => {
				subscriberFactoryCalls++;
				return subscriber;
			},
			createWatcher: () => {
				watcherFactoryCalls++;
				return fakeWatcher;
			},
			debounceMs: 10,
		};
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: true,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});

		await startCloudSyncWatcherIfEnabled(workspaceRoot, deps);
		for (let i = 0; i < 5; i++) {
			// The realistic caller-side event for "connection restored" —
			// idempotent while already running (R25).
			await startCloudSyncWatcherIfEnabled(workspaceRoot, deps);
			fireFilesChanged("ws-1");
		}
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(subscriberFactoryCalls).toBe(1);
		expect(watcherFactoryCalls).toBe(1);
		expect(activeCloudSyncWorkspaceCount()).toBe(1);
		expect(getListenerCount()).toBe(1);
	});
});

describe("changing the never-synced folder list restarts the live watcher (R25)", () => {
	it("closes the watcher built with the old list and creates exactly one replacement carrying the new one", async () => {
		const { backend } = createFakeBackend();
		const { subscriber } = createFakeSubscriber();
		const createdWatchers: {
			excludedFolders: readonly string[];
			close: ReturnType<typeof vi.fn>;
		}[] = [];
		const deps = {
			echoTracker: createSelfWriteEchoTracker(),
			grantedRoots: [workspaceRoot],
			keychain: createFakeKeychain({ [SHARED_CLOUD_SYNC_ACCOUNT]: "pw" }),
			createBackend: () => backend,
			createSubscriber: () => subscriber,
			createWatcher: (
				_workspaceRoot: string,
				excludedFolders: readonly string[],
			) => {
				const close = vi.fn(async () => {});
				createdWatchers.push({ excludedFolders: [...excludedFolders], close });
				return {
					on: vi.fn(function (this: unknown) {
						return this;
					}),
					close,
				} as unknown as FSWatcher;
			},
			debounceMs: 10,
		};
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: true,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});

		await startCloudSyncWatcherIfEnabled(workspaceRoot, deps);
		expect(createdWatchers).toHaveLength(1);
		// The first watcher was built with the built-in defaults.
		expect(createdWatchers[0]?.excludedFolders).toContain(".claude");
		expect(createdWatchers[0]?.excludedFolders).toContain("node_modules");

		const state = await setCloudSyncExcludedFolders(
			workspaceRoot,
			[".claude", "vendor"],
			deps,
		);

		// Old watcher torn down, exactly one replacement, built with the new list.
		expect(createdWatchers[0]?.close).toHaveBeenCalled();
		expect(createdWatchers).toHaveLength(2);
		expect(createdWatchers[1]?.excludedFolders).toEqual([".claude", "vendor"]);
		expect(createdWatchers[1]?.close).not.toHaveBeenCalled();
		// Still exactly one live workspace handle -- no leaked duplicate (R25).
		expect(activeCloudSyncWorkspaceCount()).toBe(1);
		expect(isCloudSyncRunning(workspaceRoot)).toBe(true);
		expect(state.excludedFolders).toEqual([".claude", "vendor"]);
	});

	it("leaves a workspace that is not running without starting one behind the user's back", async () => {
		const { backend } = createFakeBackend();
		const { subscriber } = createFakeSubscriber();
		const createWatcher = vi.fn(
			() =>
				({
					on: vi.fn(function (this: unknown) {
						return this;
					}),
					close: vi.fn(async () => {}),
				}) as unknown as FSWatcher,
		);
		const deps = {
			echoTracker: createSelfWriteEchoTracker(),
			grantedRoots: [workspaceRoot],
			keychain: createFakeKeychain({ [SHARED_CLOUD_SYNC_ACCOUNT]: "pw" }),
			createBackend: () => backend,
			createSubscriber: () => subscriber,
			createWatcher,
			debounceMs: 10,
		};
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: false,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});

		await setCloudSyncExcludedFolders(workspaceRoot, ["vendor"], deps);

		expect(createWatcher).not.toHaveBeenCalled();
		expect(isCloudSyncRunning(workspaceRoot)).toBe(false);
	});
});

describe("Keychain-only credential storage (R20)", () => {
	it("the shared password is never written into .hubble/config.json", async () => {
		await fs.writeFile(path.join(workspaceRoot, "note.md"), "hello");
		const { backend } = createFakeBackend();
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

		await enableCloudSyncForWorkspace(
			{
				workspaceRoot,
				workspaceName: "ws",
				deploymentUrl: "http://127.0.0.1:8787",
				password: "super-secret-shared-password",
			},
			deps,
		);

		const configRaw = await fs.readFile(
			path.join(workspaceRoot, ".hubble", "config.json"),
			"utf8",
		);
		expect(configRaw).not.toContain("super-secret-shared-password");
		const parsed = JSON.parse(configRaw);
		expect(Object.keys(parsed.cloudSync).sort()).toEqual(
			[
				"backgroundSync",
				"deploymentUrl",
				"deviceId",
				"provider",
				"workspaceId",
			].sort(),
		);
		expect(keychain.calls.setPassword).toBe(1);
	});
});

describe("password rotation surfaces a visible re-authenticate state (R20 + Stage 1 flag)", () => {
	it("no credential stored yet -> needs-reauth, not a silent stall", async () => {
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: true,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});
		const deps = {
			echoTracker: createSelfWriteEchoTracker(),
			grantedRoots: [workspaceRoot],
			keychain: createFakeKeychain(),
		};

		const state = await startCloudSyncWatcherIfEnabled(workspaceRoot, deps);
		expect(state.status).toBe("needs-reauth");
		expect(isCloudSyncRunning(workspaceRoot)).toBe(false);
	});

	it("a stale/rotated password rejected by the backend (401) surfaces needs-reauth, never a silent stall", async () => {
		const { backend } = createFakeBackend();
		backend.getFiles = async () => {
			throw new CloudflareResponseError("unauthorized", 401);
		};
		const { subscriber } = createFakeSubscriber();
		const statuses: CloudSyncStatus[] = [];
		const deps = {
			echoTracker: createSelfWriteEchoTracker(),
			grantedRoots: [workspaceRoot],
			keychain: createFakeKeychain({
				[SHARED_CLOUD_SYNC_ACCOUNT]: "stale-password",
			}),
			createBackend: () => backend,
			createSubscriber: () => subscriber,
			debounceMs: 20,
		};
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: true,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});
		onCloudSyncStatusChange(workspaceRoot, (status) => statuses.push(status));

		await startCloudSyncWatcherIfEnabled(workspaceRoot, deps);

		expect(getCloudSyncStatus(workspaceRoot)).toBe("needs-reauth");
		expect(statuses).toContain("needs-reauth");
	});
});

describe("workspace folder becoming unavailable (R24)", () => {
	it("surfaces a persistent workspace-unavailable status and tears the watcher down cleanly — no crash, no silent infinite retry", async () => {
		const { backend } = createFakeBackend();
		let getFilesCalls = 0;
		backend.getFiles = async () => {
			getFilesCalls++;
			const error = new Error(
				"ENOENT: no such file or directory",
			) as NodeJS.ErrnoException;
			error.code = "ENOENT";
			throw error;
		};
		const { subscriber } = createFakeSubscriber();
		const deps = {
			echoTracker: createSelfWriteEchoTracker(),
			grantedRoots: [workspaceRoot],
			keychain: createFakeKeychain({ [SHARED_CLOUD_SYNC_ACCOUNT]: "pw" }),
			createBackend: () => backend,
			createSubscriber: () => subscriber,
			deleteWorkspaceRemote: createFakeWorkspaceDeleter().deleteWorkspaceRemote,
			debounceMs: 20,
		};
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: true,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});

		await startCloudSyncWatcherIfEnabled(workspaceRoot, deps);
		// The status stays visible (never quietly resets to "off") ...
		expect(getCloudSyncStatus(workspaceRoot)).toBe("workspace-unavailable");
		// ... but the live watcher/subscriber is torn down, not left running.
		expect(isCloudSyncRunning(workspaceRoot)).toBe(false);

		const callsRightAfterFailure = getFilesCalls;
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(getFilesCalls).toBe(callsRightAfterFailure); // no silent retry loop

		// Explicitly turning it off and back on is the documented recovery path.
		await disableCloudSyncForWorkspace(workspaceRoot, deps);
		expect(getCloudSyncStatus(workspaceRoot)).toBe("off");
	});
});

describe("workspace too large to sync (the maxEntries backstop)", () => {
	it("surfaces a persistent workspace-too-large status and tears the watcher down cleanly — no crash, no silent infinite retry", async () => {
		const { backend } = createFakeBackend();
		let getFilesCalls = 0;
		backend.getFiles = async () => {
			getFilesCalls++;
			throw new WorkspaceTraversalLimitError(200_000, 200_001);
		};
		const { subscriber } = createFakeSubscriber();
		const deps = {
			echoTracker: createSelfWriteEchoTracker(),
			grantedRoots: [workspaceRoot],
			keychain: createFakeKeychain({ [SHARED_CLOUD_SYNC_ACCOUNT]: "pw" }),
			createBackend: () => backend,
			createSubscriber: () => subscriber,
			deleteWorkspaceRemote: createFakeWorkspaceDeleter().deleteWorkspaceRemote,
			debounceMs: 20,
		};
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: true,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});

		await startCloudSyncWatcherIfEnabled(workspaceRoot, deps);
		// The status stays visible (never quietly resets to "off") ...
		expect(getCloudSyncStatus(workspaceRoot)).toBe("workspace-too-large");
		// ... but the live watcher/subscriber is torn down, not left running.
		expect(isCloudSyncRunning(workspaceRoot)).toBe(false);

		const callsRightAfterFailure = getFilesCalls;
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(getFilesCalls).toBe(callsRightAfterFailure); // no silent retry loop

		// Explicitly turning it off and back on is the documented recovery path.
		await disableCloudSyncForWorkspace(workspaceRoot, deps);
		expect(getCloudSyncStatus(workspaceRoot)).toBe("off");
	});
});
