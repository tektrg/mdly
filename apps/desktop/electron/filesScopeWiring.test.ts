import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createFakeBackend,
	createFakeKeychain,
	createFakeSubscriber,
	writeCloudSyncConfigFixture,
} from "./cloudSyncTestDoubles";
import {
	excludePendingFolder,
	readCloudSyncWorkspaceState,
	SHARED_CLOUD_SYNC_ACCOUNT,
	setCloudSyncExcludedFolders,
	stopAllCloudSync,
} from "./cloudSyncWiring";
import { createSelfWriteEchoTracker } from "./docHistoryWiring";
import { collectDocumentFiles } from "./fileDiscovery";
import {
	appListingOptions,
	countFilesInScope,
	readRawWorkspaceConfigFile,
	readWorkspaceFilesScope,
	writeWorkspaceFilesScope,
} from "./filesScopeWiring";

let workspaceRoot: string;

beforeEach(async () => {
	workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "files-scope-"));
});

afterEach(async () => {
	await stopAllCloudSync();
	await fs.rm(workspaceRoot, { recursive: true, force: true });
});

function deps() {
	return {
		echoTracker: createSelfWriteEchoTracker(),
		grantedRoots: [workspaceRoot],
		keychain: createFakeKeychain({ [SHARED_CLOUD_SYNC_ACCOUNT]: "pw" }),
		createBackend: () => createFakeBackend().backend,
		createSubscriber: () => createFakeSubscriber().subscriber,
		debounceMs: 20,
	};
}

async function writeFiles(files: Record<string, string>) {
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(workspaceRoot, rel);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, content);
	}
}

async function listedPaths() {
	const { scope } = await readWorkspaceFilesScope(workspaceRoot);
	const listing = { files: [], folders: [] };
	await collectDocumentFiles(workspaceRoot, listing, appListingOptions(scope));
	return (listing.files as { path: string }[])
		.map((file) => path.relative(workspaceRoot, file.path))
		.sort();
}

describe("Files scope migration", () => {
	it("legacy excludedFolders become In app ✓ / Synced ✗ — the sidebar is unchanged", async () => {
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: false,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});
		await setCloudSyncExcludedFolders(workspaceRoot, ["vendor"], deps());
		await writeFiles({ "vendor/a.md": "", "notes/b.md": "" });

		const state = await readWorkspaceFilesScope(workspaceRoot);
		expect(state.isCustomized).toBe(false);
		expect(state.scope.rules).toEqual([
			{ pattern: "vendor", inApp: true, synced: false },
		]);
		expect(await listedPaths()).toEqual(["notes/b.md", "vendor/a.md"]);
		expect(await countFilesInScope(workspaceRoot, state.scope)).toEqual({
			visible: 2,
			synced: 1,
		});
	});

	it("saving scope supersedes the legacy list and drives sync + listing", async () => {
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: false,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});
		await writeFiles({ "private/a.md": "", "drafts/b.md": "", "c.md": "" });
		await writeWorkspaceFilesScope(workspaceRoot, {
			respectGitignore: true,
			rules: [
				{ pattern: "private", inApp: false, synced: true },
				{ pattern: "drafts", inApp: true, synced: false },
			],
		});

		const raw = (await readRawWorkspaceConfigFile(workspaceRoot)) as {
			cloudSync: Record<string, unknown>;
			scope: unknown;
		};
		expect(raw.cloudSync.excludedFolders).toBeUndefined();
		expect(raw.cloudSync.workspaceId).toBe("ws-1");
		expect(await listedPaths()).toEqual(["c.md", "drafts/b.md"]);
		const sync = await readCloudSyncWorkspaceState(workspaceRoot);
		expect(sync.excludedFolders).toEqual(
			expect.arrayContaining(["node_modules", "private", "drafts"]),
		);
	});

	it("respectGitignore off lists gitignored files; sync still skips them", async () => {
		await writeFiles({ ".gitignore": "out/\n", "out/a.md": "", "b.md": "" });
		await writeWorkspaceFilesScope(workspaceRoot, {
			respectGitignore: false,
			rules: [],
		});
		expect(await listedPaths()).toEqual(["b.md", "out/a.md"]);
		const { scope } = await readWorkspaceFilesScope(workspaceRoot);
		expect(await countFilesInScope(workspaceRoot, scope)).toEqual({
			visible: 2,
			synced: 1,
		});
	});

	it("large-folder 'never sync' writes into a customized scope", async () => {
		await writeCloudSyncConfigFixture(workspaceRoot, {
			backgroundSync: false,
			workspaceId: "ws-1",
			deploymentUrl: "http://127.0.0.1:8787",
		});
		await writeWorkspaceFilesScope(workspaceRoot, {
			respectGitignore: true,
			rules: [{ pattern: "drafts", inApp: true, synced: false }],
		});
		await excludePendingFolder(workspaceRoot, "big", deps());
		const { scope } = await readWorkspaceFilesScope(workspaceRoot);
		expect(scope.rules).toEqual([
			{ pattern: "drafts", inApp: true, synced: false },
			{ pattern: "big", inApp: true, synced: false },
		]);
		const raw = (await readRawWorkspaceConfigFile(workspaceRoot)) as {
			cloudSync: Record<string, unknown>;
		};
		expect(raw.cloudSync.excludedFolders).toBeUndefined();
	});
});
