/**
 * Large-workspace sync coverage (D-LW3/D-LW4/D-LW5): plan→execute wiring with
 * throttled progress, the pending-folder hold queue, the directory-count cap,
 * and the local scope preview. Shares the doubles in
 * `cloudSyncTestDoubles.ts`.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createFakeBackend,
	createFakeKeychain,
	createFakeSubscriber,
	waitFor,
	writeCloudSyncConfigFixture,
} from "./cloudSyncTestDoubles";
import {
	approvePendingFolder,
	detectAndHoldPendingFolders,
	excludePendingFolder,
	isCloudSyncRunning,
	isPrunedCloudSyncPath,
	onCloudSyncProgressChange,
	onCloudSyncStatusChange,
	prepareCloudSyncPreview,
	readCloudSyncWorkspaceState,
	SHARED_CLOUD_SYNC_ACCOUNT,
	setCloudSyncExcludedFolders,
	startCloudSyncWatcherIfEnabled,
	stopAllCloudSync,
} from "./cloudSyncWiring";
import { createSelfWriteEchoTracker } from "./docHistoryWiring";

let workspaceRoot: string;

beforeEach(async () => {
	workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-sync-lw-"));
});

afterEach(async () => {
	await stopAllCloudSync();
	await fs.rm(workspaceRoot, { recursive: true, force: true });
});

function depsFor() {
	const { backend, calls } = createFakeBackend();
	const { subscriber } = createFakeSubscriber();
	return {
		deps: {
			echoTracker: createSelfWriteEchoTracker(),
			grantedRoots: [workspaceRoot],
			keychain: createFakeKeychain({ [SHARED_CLOUD_SYNC_ACCOUNT]: "pw" }),
			createBackend: () => backend,
			createSubscriber: () => subscriber,
			debounceMs: 20,
		},
		calls,
	};
}

async function writeFiles(dir: string, count: number) {
	await fs.mkdir(dir, { recursive: true });
	for (let i = 0; i < count; i++)
		await fs.writeFile(path.join(dir, `f${i}.md`), `note ${i}`);
}

describe("pending folders (D-LW5)", () => {
	it("holds a new >1,000-file folder pending while the rest keeps syncing", async () => {
		await fs.writeFile(path.join(workspaceRoot, "keep.md"), "keep");
		await writeFiles(path.join(workspaceRoot, "big-import"), 1050);
		const { deps, calls } = depsFor();
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: true,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});

		const newly = await detectAndHoldPendingFolders(workspaceRoot, deps);
		expect(newly.map((p) => p.path)).toEqual(["big-import"]);
		expect(newly[0]?.fileCountAtLeast).toBeGreaterThanOrEqual(1001);

		// Persisted — first sync IS the pending queue at t=0, one state.
		const reread = await readCloudSyncWorkspaceState(workspaceRoot);
		expect(reread.pendingFolders.map((p) => p.path)).toEqual(["big-import"]);

		// The rest of the workspace keeps syncing: start and assert the held
		// folder's files never reach the backend.
		await startCloudSyncWatcherIfEnabled(workspaceRoot, deps);
		expect(calls.pushFile).toContain("keep.md");
		expect(calls.pushFile.some((p) => p.startsWith("big-import/"))).toBe(false);
	}, 60000);

	it("approve → syncs it; exclude → never asks again", async () => {
		await writeFiles(path.join(workspaceRoot, "docs"), 1050);
		const { deps } = depsFor();
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: true,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});
		await detectAndHoldPendingFolders(workspaceRoot, deps);

		const approved = await approvePendingFolder(workspaceRoot, "docs", deps);
		expect(approved.pendingFolders).toEqual([]);

		// Re-hold, then exclude: lands in excludedFolders, leaves the queue.
		await detectAndHoldPendingFolders(workspaceRoot, deps);
		const excluded = await excludePendingFolder(workspaceRoot, "docs", deps);
		expect(excluded.pendingFolders).toEqual([]);
		expect(excluded.excludedFolders).toContain("docs");

		// A recreated folder with the same path never re-nags.
		await writeFiles(path.join(workspaceRoot, "docs"), 1050);
		const renagged = await detectAndHoldPendingFolders(workspaceRoot, deps);
		expect(renagged).toEqual([]);
	}, 60000);

	it("a nested repo never reaches the pending queue (D-LW1 auto-excludes it silently)", async () => {
		await writeFiles(path.join(workspaceRoot, "worktree"), 1050);
		await fs.mkdir(path.join(workspaceRoot, "worktree", ".git"), {
			recursive: true,
		});
		const { deps } = depsFor();
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: true,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});

		expect(await detectAndHoldPendingFolders(workspaceRoot, deps)).toEqual([]);
	}, 30000);
});

describe("structured progress (D-LW3)", () => {
	it("runOnce emits scan (indeterminate) then determinate progress", async () => {
		await fs.writeFile(path.join(workspaceRoot, "a.md"), "a");
		const { deps } = depsFor();
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: true,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});

		const seen: { phase: string; done: number; total: number | null }[] = [];
		const off = onCloudSyncProgressChange(workspaceRoot, (p) => {
			seen.push({ phase: p.phase, done: p.done, total: p.total });
		});
		try {
			await startCloudSyncWatcherIfEnabled(workspaceRoot, deps);
		} finally {
			off();
		}
		expect(seen.length).toBeGreaterThan(0);
		expect(seen[seen.length - 1]?.phase).toBe("done");
		// Determinate emissions carry a real total — never a fake bar.
		const determinate = seen.filter((s) => s.total !== null);
		expect(determinate.length).toBeGreaterThan(0);
		for (const d of determinate)
			expect(d.done).toBeLessThanOrEqual(d.total ?? 0);
	});
});

describe("engine-backed review preview (items 2+3)", () => {
	function prepareDeps() {
		const { backend, calls } = createFakeBackend();
		const { subscriber } = createFakeSubscriber();
		return {
			deps: {
				echoTracker: createSelfWriteEchoTracker(),
				grantedRoots: [workspaceRoot],
				keychain: createFakeKeychain({ [SHARED_CLOUD_SYNC_ACCOUNT]: "pw" }),
				createBackend: () => backend,
				createSubscriber: () => subscriber,
				debounceMs: 20,
			},
			calls,
		};
	}

	it("preview counts come from the real plan: .gitignore-d files are absent", async () => {
		// Item-3 repro: the old third walker reported 2 files here while the
		// real sync synced 1. One walker (plan) cannot disagree with itself.
		await fs.writeFile(path.join(workspaceRoot, ".gitignore"), "build/\n");
		await fs.writeFile(path.join(workspaceRoot, "top.md"), "hello");
		await fs.mkdir(path.join(workspaceRoot, "build"), { recursive: true });
		await fs.writeFile(
			path.join(workspaceRoot, "build", "generated.md"),
			"generated",
		);
		const { deps } = prepareDeps();

		const { plan, folders } = await prepareCloudSyncPreview(
			{
				workspaceRoot,
				workspaceName: "test-workspace",
				deploymentUrl: "http://127.0.0.1:8787",
			},
			deps,
		);

		expect(plan.toPush.map((p) => p.path)).toEqual(["top.md"]);
		expect(plan.totalOps).toBe(1);
		expect(folders.some((f) => f.folder === "build")).toBe(false);
	});

	it("excluded tops come back as greyed rows with engine reasons", async () => {
		await fs.writeFile(path.join(workspaceRoot, "top.md"), "hello");
		await writeFiles(path.join(workspaceRoot, "vendor"), 3);
		const { deps } = prepareDeps();
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: false,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});
		// Pretend a previous session excluded vendor.
		await setCloudSyncExcludedFolders(workspaceRoot, ["vendor"], deps);

		const { folders } = await prepareCloudSyncPreview(
			{
				workspaceRoot,
				workspaceName: "test-workspace",
				deploymentUrl: "http://127.0.0.1:8787",
			},
			deps,
		);

		const vendor = folders.find((f) => f.folder === "vendor");
		expect(vendor?.autoExcluded).toBe("gitignored");
		expect(vendor?.fileCount).toBe(3);
		const top = folders.find((f) => f.folder === "(root)");
		expect(top?.autoExcluded).toBeUndefined();
	});

	it("prepare persists a dormant config and stores the password, starting nothing", async () => {
		await fs.writeFile(path.join(workspaceRoot, "a.md"), "a");
		const { deps } = prepareDeps();

		await prepareCloudSyncPreview(
			{
				workspaceRoot,
				workspaceName: "test-workspace",
				deploymentUrl: "http://127.0.0.1:8787",
				password: "fresh-password",
			},
			deps,
		);

		const state = await readCloudSyncWorkspaceState(workspaceRoot);
		expect(state.backgroundSync).toBe(false);
		expect(state.workspaceId).toBe("ws-1");
		// Nothing started: no watcher, nothing pushed.
		expect(isCloudSyncRunning(workspaceRoot)).toBe(false);
	});
});

describe("anchored pruning in the watcher path", () => {
	it("prunes fe/docs but syncs docs/ and other/fe/docs/", () => {
		const entries = ["fe/docs"];
		expect(isPrunedCloudSyncPath("/ws/fe/docs/a.md", "/ws", entries)).toBe(
			true,
		);
		expect(isPrunedCloudSyncPath("/ws/docs/a.md", "/ws", entries)).toBe(false);
		expect(
			isPrunedCloudSyncPath("/ws/other/fe/docs/a.md", "/ws", entries),
		).toBe(false);
	});
});

describe("live arrival race (item 1)", () => {
	it("a folder materializing over >5s is never synced before the hold applies", async () => {
		await fs.writeFile(path.join(workspaceRoot, "keep.md"), "keep");
		const { deps, calls } = depsFor();
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: true,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});
		await startCloudSyncWatcherIfEnabled(workspaceRoot, deps);
		await waitFor(() => calls.pushFile.includes("keep.md"));

		// A worktree-style arrival: 1,080 files dripping in over ~6s, past
		// the 5s sync max-wait. The old two-timer shape synced these at the
		// max-wait firing; the provisional hold must prevent every push.
		const slowDir = path.join(workspaceRoot, "slow-worktree");
		await fs.mkdir(slowDir, { recursive: true });
		for (let batch = 0; batch < 12; batch++) {
			for (let i = 0; i < 90; i++)
				await fs.writeFile(
					path.join(slowDir, `b${batch}-f${i}.md`),
					`content ${batch}/${i}`,
				);
			// The hold must already apply DURING the arrival, not after.
			expect(
				calls.pushFile.some((p) => p.startsWith("slow-worktree/")),
				`batch ${batch}: nothing from the arriving folder may push`,
			).toBe(false);
			await new Promise((resolve) => setTimeout(resolve, 500));
		}

		// Arrival stops → quiet + stable → vet check holds it (no approval yet).
		await waitFor(async () => {
			const state = await readCloudSyncWorkspaceState(workspaceRoot);
			return state.pendingFolders.some((p) => p.path === "slow-worktree");
		}, 15000);
		expect(calls.pushFile.some((p) => p.startsWith("slow-worktree/"))).toBe(
			false,
		);

		// Approval releases exactly the held subtree; the rest was syncing
		// all along. Approval is durable: the post-approval event backlog
		// must not re-hold the same path.
		await approvePendingFolder(workspaceRoot, "slow-worktree", deps);
		await waitFor(
			() =>
				calls.pushFile.filter((p) => p.startsWith("slow-worktree/")).length >=
				1080,
			20000,
		);
	}, 60000);

	it("a small live-arriving folder is vetted and synced (no permanent hold)", async () => {
		const { deps, calls } = depsFor();
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: true,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});
		await startCloudSyncWatcherIfEnabled(workspaceRoot, deps);

		await fs.mkdir(path.join(workspaceRoot, "smalldir"), { recursive: true });
		await fs.writeFile(path.join(workspaceRoot, "smalldir", "a.md"), "a");
		await fs.writeFile(path.join(workspaceRoot, "smalldir", "b.md"), "b");

		// Provisionally withheld at first, then vetted once quiet and picked
		// up by the follow-up pass — never held pending (far under threshold).
		await waitFor(() => calls.pushFile.includes("smalldir/a.md"), 20000);
		await waitFor(() => calls.pushFile.includes("smalldir/b.md"), 20000);
		const state = await readCloudSyncWorkspaceState(workspaceRoot);
		expect(state.pendingFolders).toEqual([]);
	}, 60000);
});

describe("drain-cap honesty (item 4)", () => {
	it("hitting the cap reports catching-up (never idle) and still syncs the tail", async () => {
		const { backend, calls } = createFakeBackend();
		// Slow every manifest fetch so each pass lasts ~300ms — a sustained
		// trigger burst then deterministically outlasts MAX_DRAIN_ITERATIONS.
		const slowBackend = {
			...backend,
			async getFiles(...args: Parameters<typeof backend.getFiles>) {
				await new Promise((resolve) => setTimeout(resolve, 150));
				return backend.getFiles(...args);
			},
		};
		const { subscriber } = createFakeSubscriber();
		const deps = {
			echoTracker: createSelfWriteEchoTracker(),
			grantedRoots: [workspaceRoot],
			keychain: createFakeKeychain({ [SHARED_CLOUD_SYNC_ACCOUNT]: "pw" }),
			createBackend: () => slowBackend,
			createSubscriber: () => subscriber,
			debounceMs: 20,
		};
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: true,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});

		const seen: { status: string; detail: string | null }[] = [];
		const off = onCloudSyncStatusChange(workspaceRoot, (status, detail) => {
			seen.push({ status, detail });
		});
		try {
			await startCloudSyncWatcherIfEnabled(workspaceRoot, deps);

			// ~25 writes, 60ms apart: pending>0 at the end of EVERY pass, so
			// the 4th pass boundary hits the cap with a live tail.
			for (let i = 0; i < 25; i++) {
				await fs.writeFile(
					path.join(workspaceRoot, `burst-${i}.md`),
					`content ${i}`,
				);
				await new Promise((resolve) => setTimeout(resolve, 60));
			}

			// The cap fired with work outstanding: honest catching-up status,
			// never a premature idle. (The old code zeroed the counter and
			// reported idle here.)
			await waitFor(
				() =>
					seen.some(
						(s) =>
							s.status === "syncing" &&
							s.detail !== null &&
							s.detail.includes("catching up"),
					),
				15000,
			);

			// And the tail still syncs: every file pushed, final state idle.
			await waitFor(() => calls.pushFile.length >= 25, 20000);
			await waitFor(async () => {
				const state = await readCloudSyncWorkspaceState(workspaceRoot);
				return state.status === "idle";
			}, 20000);
		} finally {
			off();
		}
	}, 60000);
});
