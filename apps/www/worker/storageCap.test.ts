import { describe, expect, it } from "vitest";
import { authedJson, fetchWithBearer, jsonBody } from "./testHelpers.js";

/**
 * QA8a (R7): a push that would exceed the workspace's storage cap fails with
 * a specific, distinct error — never a generic 500, a silent drop, or
 * partial/corrupt data. The cap is overridden to 2,000,000 bytes for this
 * whole test file (vitest.config.ts's WORKSPACE_STORAGE_CAP_BYTES binding)
 * so this is fast to exercise without writing gigabytes of fixture content.
 */
describe("storage cap produces a specific, distinct error (R7)", () => {
	it("a single push that alone exceeds the cap is rejected with STORAGE_CAP_EXCEEDED, not a generic 500", async () => {
		const workspaceId = "storage-cap-ws-single";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		// Over the 2,000,000-byte test cap but under the 2MiB per-file
		// SQLite ceiling, so this exercises the quota check specifically.
		const tooBig = "x".repeat(2_050_000);
		const push = await authedJson<{ error: string; code: string }>(
			"/api/files",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					path: "huge.md",
					contentHash: "h",
					content: tooBig,
					deviceId: "d",
				}),
			},
		);

		expect(push.status).toBe(413);
		expect(push.body.code).toBe("STORAGE_CAP_EXCEEDED");

		const files = await authedJson<{ files: unknown[] }>(
			`/api/files?workspaceId=${workspaceId}`,
		);
		expect(files.body.files).toHaveLength(0); // no partial/corrupt row was written
	});

	it("a push that fits comfortably under the cap still succeeds", async () => {
		const workspaceId = "storage-cap-ws-fits";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const push = await authedJson<{ ok: true; version: number }>("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "small.md",
				contentHash: "h",
				content: "hello",
				deviceId: "d",
			}),
		});
		expect(push.body.ok).toBe(true);
	});

	it("cumulative pushes that would together exceed the cap are rejected on the push that crosses it", async () => {
		const workspaceId = "storage-cap-ws-cumulative";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const chunk = "y".repeat(900_000); // three of these exceed the 2,000,000-byte cap
		const first = await authedJson<{ ok: true }>("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "a.md",
				contentHash: "h",
				content: chunk,
				deviceId: "d",
			}),
		});
		expect(first.body.ok).toBe(true);

		const second = await authedJson<{ ok: true }>("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "b.md",
				contentHash: "h",
				content: chunk,
				deviceId: "d",
			}),
		});
		expect(second.body.ok).toBe(true);

		const third = await authedJson<{ error: string; code: string }>(
			"/api/files",
			{
				method: "POST",
				...jsonBody({
					workspaceId,
					path: "c.md",
					contentHash: "h",
					content: chunk,
					deviceId: "d",
				}),
			},
		);
		expect(third.status).toBe(413);
		expect(third.body.code).toBe("STORAGE_CAP_EXCEEDED");
	});
});
