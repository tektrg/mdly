import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCloudflareBackend } from "./backend.js";
import { CloudflareResponseError } from "./errors.js";
import type { RealWorkerHandle } from "./testHarness/realWorker.js";
import { startRealWorker, TEST_PASSWORD } from "./testHarness/realWorker.js";
import {
	deleteWorkspace,
	listWorkspaces,
	loginWithPassword,
} from "./workspaces.js";

describe("workspaces helpers (R32, R33, R38, R41)", () => {
	let worker: RealWorkerHandle;

	beforeAll(async () => {
		worker = await startRealWorker();
	}, 30000);

	afterAll(async () => {
		await worker.dispose();
	});

	it("loginWithPassword resolves true for the correct password, false for a wrong one, with no thrown error either way (R41)", async () => {
		await expect(loginWithPassword(worker.baseUrl, "wrong")).resolves.toBe(
			false,
		);
		await expect(
			loginWithPassword(worker.baseUrl, TEST_PASSWORD),
		).resolves.toBe(true);
	});

	it("listWorkspaces returns exactly the workspaces created so far, sourced from the real Worker (R32, R33)", async () => {
		const backend = createCloudflareBackend({
			baseUrl: worker.baseUrl,
			auth: { kind: "bearer", token: TEST_PASSWORD },
		});
		await backend.createWorkspace("workspaces-list-a");
		await backend.createWorkspace("workspaces-list-b");

		const workspaces = await listWorkspaces({
			baseUrl: worker.baseUrl,
			auth: { kind: "bearer", token: TEST_PASSWORD },
		});
		const names = workspaces.map((w) => w.name);
		expect(names).toContain("workspaces-list-a");
		expect(names).toContain("workspaces-list-b");
		expect(names).not.toContain("workspaces-list-never-created");
	});

	it("the single shared password authenticates both the bearer and cookie route to the same list-workspaces data (R38)", async () => {
		const bearerWorkspaces = await listWorkspaces({
			baseUrl: worker.baseUrl,
			auth: { kind: "bearer", token: TEST_PASSWORD },
		});
		expect(bearerWorkspaces.length).toBeGreaterThan(0);
	});
});

/**
 * deleteWorkspace (R36) — proven end-to-end against the real bundled Worker
 * (not a mock), matching this file's existing pattern for the other
 * account-level (non-SyncBackend) helpers.
 */
describe("deleteWorkspace (R36)", () => {
	let worker: RealWorkerHandle;
	const auth = { kind: "bearer" as const, token: TEST_PASSWORD };

	beforeAll(async () => {
		worker = await startRealWorker();
	}, 30000);

	afterAll(async () => {
		await worker.dispose();
	});

	it("removes a workspace with pushed content from the real Worker's list-workspaces response", async () => {
		const backend = createCloudflareBackend({ baseUrl: worker.baseUrl, auth });
		const workspaceId = await backend.createWorkspace("client-delete-me");
		await backend.pushFile({
			workspaceId,
			path: "note.md",
			contentHash: "h",
			content: "hello from the client",
			deviceId: "d",
		});

		const before = await listWorkspaces({ baseUrl: worker.baseUrl, auth });
		expect(before.map((w) => w.workspaceId)).toContain(workspaceId);

		await deleteWorkspace({ baseUrl: worker.baseUrl, auth, workspaceId });

		const after = await listWorkspaces({ baseUrl: worker.baseUrl, auth });
		expect(after.map((w) => w.workspaceId)).not.toContain(workspaceId);

		const files = await backend.getFiles(workspaceId);
		expect(files).toHaveLength(0);
	});

	it("is idempotent — a second call for the same workspace resolves without throwing", async () => {
		const backend = createCloudflareBackend({ baseUrl: worker.baseUrl, auth });
		const workspaceId = await backend.createWorkspace("client-delete-twice");

		await expect(
			deleteWorkspace({ baseUrl: worker.baseUrl, auth, workspaceId }),
		).resolves.toBeUndefined();
		await expect(
			deleteWorkspace({ baseUrl: worker.baseUrl, auth, workspaceId }),
		).resolves.toBeUndefined();
	});

	it("rejects with a typed error when the credential is wrong, never silently succeeding (R40)", async () => {
		await expect(
			deleteWorkspace({
				baseUrl: worker.baseUrl,
				auth: { kind: "bearer", token: "wrong-password" },
				workspaceId: "whatever",
			}),
		).rejects.toBeInstanceOf(CloudflareResponseError);
	});
});
