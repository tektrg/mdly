import type { Env, StoredSession } from "./env.js";

/**
 * Cookie + KV session handling for the single-shared-password garden Worker.
 *
 * Mirrors apps/notion-web/worker/session.ts's cookie shape (httpOnly,
 * SameSite=Lax, Path=/, Secure when https) but swaps Notion OAuth tokens for
 * a session that only ever proves "knows the shared password" (R38 — single
 * user, no multi-tenancy). Per D4/R43 the expiry is SLIDING: every
 * authenticated request re-issues both the KV TTL and the Set-Cookie header
 * with a fresh 30-day Max-Age, never counting down from original login.
 */

const SESSION_COOKIE = "mdly_garden_sid";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days, sliding (R43/D4)

function parseCookies(header: string | null): Record<string, string> {
	const cookies: Record<string, string> = {};
	if (!header) return cookies;
	for (const part of header.split(";")) {
		const index = part.indexOf("=");
		if (index === -1) continue;
		const name = part.slice(0, index).trim();
		const value = part.slice(index + 1).trim();
		if (name) cookies[name] = decodeURIComponent(value);
	}
	return cookies;
}

export function readCookie(request: Request, name: string): string | null {
	return parseCookies(request.headers.get("Cookie"))[name] ?? null;
}

export function sessionCookieValue(request: Request): string | null {
	return readCookie(request, SESSION_COOKIE);
}

function cookie(
	name: string,
	value: string,
	{ maxAge, secure }: { maxAge: number; secure: boolean },
): string {
	const attributes = [
		`${name}=${encodeURIComponent(value)}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${maxAge}`,
	];
	if (secure) attributes.push("Secure");
	return attributes.join("; ");
}

function randomToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function newSessionId(): string {
	return randomToken();
}

export function isSecureRequest(request: Request): boolean {
	return new URL(request.url).protocol === "https:";
}

/** Fresh Set-Cookie header with a Max-Age counted from *now* (sliding). */
export function sessionSetCookie(sessionId: string, secure: boolean): string {
	return cookie(SESSION_COOKIE, sessionId, {
		maxAge: SESSION_TTL_SECONDS,
		secure,
	});
}

export function sessionClearCookie(secure: boolean): string {
	return cookie(SESSION_COOKIE, "", { maxAge: 0, secure });
}

function sessionKey(sessionId: string): string {
	return `session:${sessionId}`;
}

export async function loadSession(
	env: Env,
	sessionId: string | null,
): Promise<StoredSession | null> {
	if (!sessionId) return null;
	const raw = await env.SESSIONS.get(sessionKey(sessionId));
	if (!raw) return null;
	try {
		return JSON.parse(raw) as StoredSession;
	} catch {
		return null;
	}
}

async function writeSession(
	env: Env,
	sessionId: string,
	session: StoredSession,
): Promise<void> {
	await env.SESSIONS.put(sessionKey(sessionId), JSON.stringify(session), {
		expirationTtl: SESSION_TTL_SECONDS,
	});
}

/**
 * Creates a session and does not resolve until a follow-up read confirms it
 * is visible (R50) — guards against a freshly-logged-in client immediately
 * bouncing off a 401 caused by KV's eventual-consistency window. This only
 * closes the same-colo staleness gap; cross-region propagation delay is a
 * real, documented KV limitation this cannot fully eliminate (see the
 * handoff notes in the report for the residual risk).
 */
export async function createConfirmedSession(
	env: Env,
	sessionId: string,
): Promise<void> {
	const session: StoredSession = { createdAt: Date.now() };
	await writeSession(env, sessionId, session);

	const maxAttempts = 5;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const confirmed = await loadSession(env, sessionId);
		if (confirmed) return;
		await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
	}
	// Give up silently after retries — the write was issued; a client that
	// still races it will get a 401 and can retry, which is the pre-R50
	// behavior. Failing the login outright here would be worse.
}

/** Refreshes both the KV TTL and the Set-Cookie header from *now* (R43). */
export async function refreshSession(
	env: Env,
	sessionId: string,
): Promise<void> {
	await writeSession(env, sessionId, { createdAt: Date.now() });
}

export async function deleteSession(
	env: Env,
	sessionId: string | null,
): Promise<void> {
	if (!sessionId) return;
	await env.SESSIONS.delete(sessionKey(sessionId));
}
