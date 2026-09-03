import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudflareBackend } from "./backend.js";
import {
	CloudflareResponseError,
	CloudflareValidationError,
} from "./errors.js";
import { listWorkspaces } from "./workspaces.js";

/**
 * R9: every response is zod-validated. A malformed or unexpected backend
 * response must surface as a clear, typed sync error — never crash the
 * caller, never silently hand back corrupted data.
 */
describe("zod validation surfaces a clear error for a malformed/unexpected response (R9)", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	function mockJsonResponse(body: unknown, init?: ResponseInit) {
		globalThis.fetch = vi.fn(
			async () =>
				new Response(JSON.stringify(body), {
					status: 200,
					headers: { "Content-Type": "application/json" },
					...init,
				}),
		) as unknown as typeof fetch;
	}

	it("rejects a getFiles response with a missing required field, without crashing", async () => {
		mockJsonResponse({
			files: [{ path: "note.md" /* missing _id, contentHash, content, ... */ }],
		});
		const backend = createCloudflareBackend({
			baseUrl: "https://garden.invalid",
			auth: { kind: "bearer", token: "t" },
		});

		await expect(backend.getFiles("ws")).rejects.toBeInstanceOf(
			CloudflareValidationError,
		);
		await expect(backend.getFiles("ws")).rejects.toThrow(
			/doesn't match the expected shape/,
		);
	});

	it("rejects a response of the wrong shape entirely (e.g. an array instead of an object)", async () => {
		mockJsonResponse([1, 2, 3]);
		const backend = createCloudflareBackend({
			baseUrl: "https://garden.invalid",
			auth: { kind: "bearer", token: "t" },
		});
		await expect(backend.getAssets("ws")).rejects.toBeInstanceOf(
			CloudflareValidationError,
		);
	});

	it("rejects a 2xx response whose body isn't valid JSON", async () => {
		globalThis.fetch = vi.fn(
			async () => new Response("not json at all", { status: 200 }),
		) as unknown as typeof fetch;
		const backend = createCloudflareBackend({
			baseUrl: "https://garden.invalid",
			auth: { kind: "bearer", token: "t" },
		});
		await expect(backend.getFiles("ws")).rejects.toBeInstanceOf(
			CloudflareValidationError,
		);
	});

	it("a field with the wrong TYPE (not just missing) is also rejected, not coerced", async () => {
		mockJsonResponse({
			files: [
				{
					_id: "note.md",
					path: "note.md",
					contentHash: "h",
					content: "hi",
					updatedAt: "not-a-number", // wrong type
					deviceId: "d",
					deleted: false,
				},
			],
		});
		const backend = createCloudflareBackend({
			baseUrl: "https://garden.invalid",
			auth: { kind: "bearer", token: "t" },
		});
		await expect(backend.getFiles("ws")).rejects.toBeInstanceOf(
			CloudflareValidationError,
		);
	});

	it("a well-formed non-2xx error response surfaces as CloudflareResponseError with the Worker's own code, not a validation error", async () => {
		mockJsonResponse(
			{ error: "Workspace storage cap exceeded", code: "STORAGE_CAP_EXCEEDED" },
			{ status: 413 },
		);
		const backend = createCloudflareBackend({
			baseUrl: "https://garden.invalid",
			auth: { kind: "bearer", token: "t" },
		});
		await expect(
			backend.pushFile({
				workspaceId: "ws",
				path: "note.md",
				contentHash: "h",
				content: "x",
				deviceId: "d",
			}),
		).rejects.toMatchObject({
			code: "STORAGE_CAP_EXCEEDED",
			status: 413,
		});
	});

	it("listWorkspaces (a non-SyncBackend helper) is validated the same way", async () => {
		mockJsonResponse({ workspaces: [{ workspaceId: "a" }] }); // missing `name`
		await expect(
			listWorkspaces({
				baseUrl: "https://garden.invalid",
				auth: { kind: "bearer", token: "t" },
			}),
		).rejects.toBeInstanceOf(CloudflareValidationError);
	});

	it("CloudflareResponseError and CloudflareValidationError are both real Error subclasses, never a bare rejection", async () => {
		mockJsonResponse({ nonsense: true });
		const backend = createCloudflareBackend({
			baseUrl: "https://garden.invalid",
			auth: { kind: "bearer", token: "t" },
		});
		try {
			await backend.getFiles("ws");
			expect.unreachable("expected getFiles to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(Error);
			expect(err).toBeInstanceOf(CloudflareValidationError);
			expect((err as Error).message).toMatch(/getFiles/);
		}
	});

	it("network failure (fetch throwing) surfaces as CloudflareResponseError, not an unhandled rejection", async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;
		const backend = createCloudflareBackend({
			baseUrl: "https://garden.invalid",
			auth: { kind: "bearer", token: "t" },
		});
		await expect(backend.getFiles("ws")).rejects.toBeInstanceOf(
			CloudflareResponseError,
		);
	});
});
