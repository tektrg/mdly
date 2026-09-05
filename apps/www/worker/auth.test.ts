import { describe, expect, it } from "vitest";
import { authenticate, handleLogin } from "./auth.js";
import {
	fetchNoAuth,
	fetchWithBearer,
	fetchWithCookie,
	jsonBody,
	login,
} from "./testHelpers.js";

const API_ROUTES_BACKING_SYNC_BACKEND: { path: string; init?: RequestInit }[] =
	[
		{ path: "/api/workspaces" },
		{ path: "/api/workspace?name=whatever" },
		{
			path: "/api/workspace",
			init: { method: "POST", ...jsonBody({ name: "x" }) },
		},
		{ path: "/api/files?workspaceId=w" },
		{
			path: "/api/files",
			init: {
				method: "POST",
				...jsonBody({
					workspaceId: "w",
					path: "a.md",
					content: "hi",
					deviceId: "d",
				}),
			},
		},
		{
			path: "/api/files/delete",
			init: {
				method: "POST",
				...jsonBody({ workspaceId: "w", path: "a.md", deviceId: "d" }),
			},
		},
		{ path: "/api/assets?workspaceId=w" },
		{
			path: "/api/assets",
			init: {
				method: "POST",
				...jsonBody({
					workspaceId: "w",
					path: "a.png",
					storageId: "h",
					deviceId: "d",
				}),
			},
		},
		{ path: "/api/asset/upload-url" },
		{ path: "/api/asset/download-url?storageId=abc" },
		{
			path: "/api/asset/upload",
			init: { method: "POST", body: new Uint8Array([1, 2, 3]) },
		},
		{ path: "/api/asset/abc123" },
		{
			path: "/api/device/register",
			init: {
				method: "POST",
				...jsonBody({ workspaceId: "w", deviceId: "d" }),
			},
		},
	];

describe("auth middleware (R40, R41)", () => {
	it("rejects every /api/* route backing the 10 SyncBackend methods when no cookie/bearer is present", async () => {
		for (const route of API_ROUTES_BACKING_SYNC_BACKEND) {
			const response = await fetchNoAuth(route.path, route.init);
			expect.soft(response.status, `route ${route.path}`).toBe(401);
			const text = await response.text();
			expect.soft(text, `route ${route.path} body`).toBe("");
		}
	});

	it("the websocket upgrade route also rejects an unauthenticated request", async () => {
		const response = await fetchNoAuth("/api/workspace/w/socket", {
			headers: { Upgrade: "websocket" },
		});
		expect(response.status).toBe(401);
	});

	it("a wrong password sets no cookie and returns a generic 401", async () => {
		const { response, cookie } = await login("definitely-not-the-password");
		expect(response.status).toBe(401);
		expect(cookie).toBeNull();
		expect(response.headers.get("Set-Cookie")).toBeNull();
	});

	it("a follow-up request using any cookie from the failed-login response still gets 401", async () => {
		const failed = await login("wrong");
		const cookieFromFailedResponse = failed.response.headers.get("Set-Cookie");
		expect(cookieFromFailedResponse).toBeNull();
		// Even sending a garbage cookie value must not authenticate.
		const followUp = await fetchWithCookie(
			"/api/workspaces",
			"mdly_garden_sid=garbage",
		);
		expect(followUp.status).toBe(401);
	});

	it("the right password sets a cookie and only then do routes return data", async () => {
		const { response, cookie } = await login();
		expect(response.status).toBe(200);
		expect(cookie).not.toBeNull();
		if (!cookie) throw new Error("expected a cookie");

		const authed = await fetchWithCookie("/api/workspaces", cookie);
		expect(authed.status).toBe(200);
		const body = (await authed.json()) as { workspaces: unknown[] };
		expect(Array.isArray(body.workspaces)).toBe(true);
	});

	it("a bearer token equal to the shared password authenticates without any cookie", async () => {
		const response = await fetchWithBearer("/api/workspaces");
		expect(response.status).toBe(200);
	});

	it("a wrong bearer token is rejected identically to a missing one", async () => {
		const response = await fetchWithBearer(
			"/api/workspaces",
			{},
			"wrong-token",
		);
		expect(response.status).toBe(401);
		const text = await response.text();
		expect(text).toBe("");
	});
});

describe("single shared password, multi-workspace (R38)", () => {
	it("one login grants access to list-workspaces and every opted-in workspace's files", async () => {
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: "workspace-one" }),
		});
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: "workspace-two" }),
		});

		const { cookie } = await login();
		if (!cookie) throw new Error("expected a cookie");

		const list = await fetchWithCookie("/api/workspaces", cookie);
		const { workspaces } = (await list.json()) as {
			workspaces: { name: string }[];
		};
		const names = workspaces.map((w) => w.name);
		expect(names).toContain("workspace-one");
		expect(names).toContain("workspace-two");

		for (const name of ["workspace-one", "workspace-two"]) {
			const files = await fetchWithCookie(
				`/api/files?workspaceId=${name}`,
				cookie,
			);
			expect.soft(files.status, name).toBe(200);
		}
	});
});

/**
 * The unset-secret hole (found 2026-09-02, before the first deploy).
 *
 * `timingSafeEqual` compares the presented bearer token against
 * `env.APP_PASSWORD`. With that secret absent or empty, an empty presented
 * credential MATCHES, so `Authorization: Bearer ` (nothing after the space)
 * authenticated successfully. Verified live against a Worker run with no
 * secret bound: `GET /api/workspaces` returned **200** before the fix and
 * 401 after it.
 *
 * That state is reachable in practice -- a deploy before
 * `wrangler secret put APP_PASSWORD`, or a secret later deleted or rotated
 * away -- so the Worker must fail closed on its own rather than depend on
 * anyone following the checklist in the right order.
 *
 * These call `authenticate`/`handleLogin` directly with a hand-built env
 * because the suite's Miniflare bindings always supply a password; that is
 * the whole condition under test, so it cannot be reproduced through SELF.
 */
describe("fails closed when APP_PASSWORD is not configured", () => {
	// Only the password field is read before the guard returns, so an empty
	// KV/bucket-free env is enough and keeps the test honest about what the
	// guard depends on.
	const unconfigured = (password: unknown) =>
		({ APP_PASSWORD: password }) as unknown as Parameters<
			typeof authenticate
		>[1];

	const bearer = (token: string) =>
		new Request("https://garden.test/api/workspaces", {
			headers: { Authorization: `Bearer ${token}` },
		});

	for (const [label, value] of [
		["undefined", undefined],
		["empty string", ""],
	] as const) {
		it(`rejects an EMPTY bearer credential when APP_PASSWORD is ${label} (the 200 that used to happen)`, async () => {
			const result = await authenticate(bearer(""), unconfigured(value));
			expect(result.ok).toBe(false);
		});

		it(`rejects a guessed bearer credential when APP_PASSWORD is ${label}`, async () => {
			const result = await authenticate(bearer("hunter2"), unconfigured(value));
			expect(result.ok).toBe(false);
		});

		it(`refuses login with ANY password when APP_PASSWORD is ${label}`, async () => {
			const response = await handleLogin(
				new Request("https://garden.test/api/login", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ password: "anything" }),
				}),
				unconfigured(value),
			);
			expect(response.status).toBe(401);
			// Same generic 401 as a wrong password -- no Set-Cookie, and nothing
			// that reveals the deployment is misconfigured (R40/R41).
			expect(response.headers.get("Set-Cookie")).toBeNull();
		});
	}
});
