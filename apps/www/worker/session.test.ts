import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithCookie, login } from "./testHelpers.js";

const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;

function maxAgeOf(setCookieHeader: string | null): number | null {
	if (!setCookieHeader) return null;
	const match = /Max-Age=(\d+)/.exec(setCookieHeader);
	return match ? Number(match[1]) : null;
}

describe("sliding session cookie (R43)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("resets Max-Age to ~30 days on a later authenticated request instead of counting down from login", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

		const { response: loginResponse, cookie } = await login();
		const loginMaxAge = maxAgeOf(loginResponse.headers.get("Set-Cookie"));
		expect(loginMaxAge).toBe(THIRTY_DAYS_SECONDS);
		if (!cookie) throw new Error("expected a cookie");

		// Advance 10 real-feeling days — a non-sliding implementation counting
		// down from login would now be at ~20 days remaining.
		vi.setSystemTime(new Date("2026-01-11T00:00:00Z"));

		const later = await fetchWithCookie("/api/workspaces", cookie);
		const laterMaxAge = maxAgeOf(later.headers.get("Set-Cookie"));
		expect(laterMaxAge).toBe(THIRTY_DAYS_SECONDS);
	});

	it("actually re-writes the KV row on every authenticated request, not just at login", async () => {
		// KV's `list()` expiration metadata is computed by the emulator from
		// the REAL host clock at `put()` time (expirationTtl is a relative
		// duration, not an absolute instant our code computes), so faking this
		// isolate's Date doesn't move it — that's not a usable signal here.
		// What our OWN code writes into the row's JSON *is* computed with this
		// isolate's (fakeable) `Date.now()` — `refreshSession` stamps a fresh
		// `createdAt` on every authenticated request — so reading that value
		// back proves a real `put()` happened on the later request, not merely
		// that the original login-time row is still sitting there untouched.
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));

		const { cookie } = await login();
		if (!cookie) throw new Error("expected a cookie");
		const sessionId = decodeURIComponent(cookie.split("=")[1] ?? "");

		const firstRaw = await env.SESSIONS.get(`session:${sessionId}`);
		const firstCreatedAt = (
			JSON.parse(firstRaw ?? "{}") as { createdAt: number }
		).createdAt;

		vi.setSystemTime(new Date("2026-02-15T00:00:00Z"));
		await fetchWithCookie("/api/workspaces", cookie);

		const secondRaw = await env.SESSIONS.get(`session:${sessionId}`);
		const secondCreatedAt = (
			JSON.parse(secondRaw ?? "{}") as { createdAt: number }
		).createdAt;

		expect(secondCreatedAt).toBeGreaterThan(firstCreatedAt);
	});
});

describe("KV eventual-consistency guard on login (R50)", () => {
	it("the session is already readable by the time login resolves", async () => {
		const { cookie } = await login();
		expect(cookie).not.toBeNull();
		if (!cookie) throw new Error("expected a cookie");

		const sessionId = decodeURIComponent(cookie.split("=")[1] ?? "");
		const raw = await env.SESSIONS.get(`session:${sessionId}`);
		expect(raw).not.toBeNull();
	});
});
