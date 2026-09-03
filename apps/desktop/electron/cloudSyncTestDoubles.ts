/**
 * Shared test doubles/fixtures for `cloudSyncWiring.test.ts` and
 * `cloudSyncWiring.reliability.test.ts` — split out purely to keep both test
 * files under the project's ~700-LOC refactor-trigger guideline. Not itself a
 * `*.test.ts` file, so vitest's default include glob never picks it up as a
 * suite.
 */
import fs from "node:fs/promises";
import type { SyncBackend } from "@hubble.md/sync";
import { writeCloudSyncConfig } from "@hubble.md/sync";
import { createNodeFileSystem } from "@hubble.md/sync/node";
import type { Subscriber } from "@mdly/cloudflare-client";
import type { KeychainCredentialStore } from "@mdly/cloudflare-client/keychain";

export type FakeRemoteRecord = {
	path: string;
	contentHash: string;
	content: string;
	deleted: boolean;
	deviceId: string;
	updatedAt: number;
};

export function createFakeBackend(seed: FakeRemoteRecord[] = []) {
	const files = new Map(seed.map((f) => [f.path, f]));
	const calls = {
		pushFile: [] as string[],
		getFiles: 0,
		softDeleteFile: [] as string[],
		createWorkspace: 0,
		getWorkspace: 0,
	};
	const backend: SyncBackend = {
		async getWorkspace() {
			calls.getWorkspace++;
			return "ws-1";
		},
		async createWorkspace() {
			calls.createWorkspace++;
			return "ws-1";
		},
		async getFiles() {
			calls.getFiles++;
			return [...files.values()].map((f) => ({ ...f, _id: f.path }));
		},
		async pushFile(args) {
			calls.pushFile.push(args.path);
			files.set(args.path, {
				path: args.path,
				contentHash: args.contentHash,
				content: args.content,
				deviceId: args.deviceId,
				deleted: false,
				updatedAt: Date.now(),
			});
		},
		async softDeleteFile(args) {
			calls.softDeleteFile.push(args.path);
			const existing = files.get(args.path);
			files.set(args.path, {
				path: args.path,
				contentHash: existing?.contentHash ?? "",
				content: existing?.content ?? "",
				deviceId: args.deviceId,
				deleted: true,
				updatedAt: Date.now(),
			});
		},
		async getAssets() {
			return [];
		},
		async pushAsset() {},
		async softDeleteAsset() {},
		async generateAssetUploadUrl() {
			return { url: "http://example.invalid/upload" };
		},
		async getAssetDownloadUrl() {
			return null;
		},
	};
	return { backend, calls, files };
}

export function createFakeSubscriber() {
	const fileListeners = new Map<string, Set<() => void>>();
	let closeCalls = 0;
	const subscriber: Subscriber = {
		onFilesChanged(workspaceId, callback) {
			let set = fileListeners.get(workspaceId);
			if (!set) {
				set = new Set();
				fileListeners.set(workspaceId, set);
			}
			set.add(callback);
			return () => {
				set?.delete(callback);
			};
		},
		onAssetsChanged() {
			return () => {};
		},
		async close() {
			closeCalls++;
		},
	};
	return {
		subscriber,
		fireFilesChanged(workspaceId: string) {
			for (const cb of fileListeners.get(workspaceId) ?? []) cb();
		},
		// Plain methods, not getters: a destructured `const { x } = obj` getter
		// captures its value once at destructure time, not a live reference —
		// callers must call these at assertion time to see current counts.
		getCloseCalls() {
			return closeCalls;
		},
		getListenerCount() {
			let n = 0;
			for (const set of fileListeners.values()) n += set.size;
			return n;
		},
	};
}

export function createFakeKeychain(
	initial: Record<string, string> = {},
): KeychainCredentialStore & {
	calls: { getPassword: number; setPassword: number; deletePassword: number };
} {
	const store = new Map(Object.entries(initial));
	const calls = { getPassword: 0, setPassword: 0, deletePassword: 0 };
	return {
		calls,
		async getPassword(account) {
			calls.getPassword++;
			return store.get(account) ?? null;
		},
		async setPassword(account, secret) {
			calls.setPassword++;
			store.set(account, secret);
		},
		async deletePassword(account) {
			calls.deletePassword++;
			store.delete(account);
		},
	};
}

/**
 * Fake for `CloudSyncWiringDeps.deleteWorkspaceRemote` (R36): defaults to
 * succeeding, or throws on every call when `shouldSucceed` is false — used
 * to prove the honesty contract (a failed remote delete must never be
 * reported as "deleted", and must persist for a later retry) without a real
 * network call.
 */
export function createFakeWorkspaceDeleter(shouldSucceed = true) {
	const calls: { deploymentUrl: string; token: string; workspaceId: string }[] =
		[];
	return {
		calls,
		deleteWorkspaceRemote: async (opts: {
			deploymentUrl: string;
			token: string;
			workspaceId: string;
		}) => {
			calls.push(opts);
			if (!shouldSucceed) {
				throw new Error("simulated network failure");
			}
		},
	};
}

export function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 3000,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = async () => {
			if (await predicate()) return resolve();
			if (Date.now() - start > timeoutMs)
				return reject(new Error("waitFor timed out"));
			setTimeout(tick, 20);
		};
		void tick();
	});
}

export async function writeCloudSyncConfigFixture(
	root: string,
	overrides: {
		backgroundSync: boolean;
		workspaceId: string;
		deploymentUrl: string;
	},
) {
	await writeCloudSyncConfig(createNodeFileSystem(), root, {
		provider: "cloudflare",
		deploymentUrl: overrides.deploymentUrl,
		workspaceId: overrides.workspaceId,
		deviceId: "test-device",
		backgroundSync: overrides.backgroundSync,
	});
}

export async function pathExists(candidate: string): Promise<boolean> {
	try {
		await fs.access(candidate);
		return true;
	} catch {
		return false;
	}
}
