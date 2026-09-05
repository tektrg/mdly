/**
 * DO row-read frequency fix (2c + 2d, desktop leg): notification-driven
 * resyncs are debounced, and a broadcast whose version matches the last one
 * this client saw skips the full sync without listing.
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
	waitFor,
	writeCloudSyncConfigFixture,
} from "./cloudSyncTestDoubles";
import {
	SHARED_CLOUD_SYNC_ACCOUNT,
	startCloudSyncWatcherIfEnabled,
	stopAllCloudSync,
} from "./cloudSyncWiring";
import { createSelfWriteEchoTracker } from "./docHistoryWiring";

let workspaceRoot: string;

beforeEach(async () => {
	workspaceRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "cloud-sync-quota-freq-"),
	);
});

afterEach(async () => {
	await stopAllCloudSync();
	await fs.rm(workspaceRoot, { recursive: true, force: true });
});

function noOpWatcher(): FSWatcher {
	return {
		on: vi.fn(function (this: unknown) {
			return this;
		}),
		close: vi.fn(async () => {}),
	} as unknown as FSWatcher;
}

async function startWithVersionedBackend(currentVersion: () => number) {
	const { backend, calls } = createFakeBackend();
	let versionCalls = 0;
	const versionedBackend = {
		...backend,
		getVersion: async () => {
			versionCalls++;
			return currentVersion();
		},
	};
	const { subscriber, fireFilesChanged } = createFakeSubscriber();
	const deps = {
		echoTracker: createSelfWriteEchoTracker(),
		grantedRoots: [workspaceRoot],
		keychain: createFakeKeychain({ [SHARED_CLOUD_SYNC_ACCOUNT]: "pw" }),
		createBackend: () => versionedBackend,
		createSubscriber: () => subscriber,
		createWatcher: () => noOpWatcher(),
		debounceMs: 10,
	};
	await writeCloudSyncConfigFixture(workspaceRoot, {
		backgroundSync: true,
		workspaceId: "ws-1",
		deploymentUrl: "http://127.0.0.1:8787",
	});
	await startCloudSyncWatcherIfEnabled(workspaceRoot, deps);
	// The initial start runs one full sync: plan lists + execute lists.
	await waitFor(() => calls.getFiles >= 2);
	return {
		calls,
		fireFilesChanged,
		versionCalls: () => versionCalls,
	};
}

describe("desktop notification-driven resync (2c + 2d)", () => {
	it("2d: broadcasts with an unchanged version skip the full sync", async () => {
		const started = await startWithVersionedBackend(() => 7);
		const getFilesBefore = started.calls.getFiles;

		started.fireFilesChanged("ws-1");
		started.fireFilesChanged("ws-1");
		// Past the 400ms remote debounce: the pre-check ran (version calls),
		// but no new listing did — the version never moved.
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(started.versionCalls()).toBeGreaterThanOrEqual(2);
		expect(started.calls.getFiles).toBe(getFilesBefore);
	});

	it("2c: rapid broadcasts with new versions collapse into a single sync", async () => {
		let version = 10;
		const started = await startWithVersionedBackend(() => version);
		const getFilesBefore = started.calls.getFiles;

		// Two broadcasts in the same tick, each with a newer version — both
		// schedule, the debounce collapses them into exactly one runOnce
		// (one plan listing + one execute listing).
		version = 11;
		started.fireFilesChanged("ws-1");
		version = 12;
		started.fireFilesChanged("ws-1");
		await waitFor(() => started.calls.getFiles >= getFilesBefore + 2);
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(started.calls.getFiles).toBe(getFilesBefore + 2);
	});
});
