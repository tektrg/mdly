import type { Env, StoredSession } from "./env";

const SESSION_COOKIE = "mdly_sid";
const OAUTH_STATE_COOKIE = "mdly_oauth_state";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

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

export function oauthStateCookieValue(request: Request): string | null {
	return readCookie(request, OAUTH_STATE_COOKIE);
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

export function newOAuthState(): string {
	return randomToken();
}

export function isSecureRequest(request: Request): boolean {
	return new URL(request.url).protocol === "https:";
}

export function sessionSetCookie(sessionId: string, secure: boolean): string {
	return cookie(SESSION_COOKIE, sessionId, {
		maxAge: SESSION_TTL_SECONDS,
		secure,
	});
}

export function sessionClearCookie(secure: boolean): string {
	return cookie(SESSION_COOKIE, "", { maxAge: 0, secure });
}

export function oauthStateSetCookie(state: string, secure: boolean): string {
	return cookie(OAUTH_STATE_COOKIE, state, { maxAge: 600, secure });
}

export function oauthStateClearCookie(secure: boolean): string {
	return cookie(OAUTH_STATE_COOKIE, "", { maxAge: 0, secure });
}

export async function loadSession(
	env: Env,
	sessionId: string | null,
): Promise<StoredSession | null> {
	if (!sessionId) return null;
	const raw = await env.SESSIONS.get(`session:${sessionId}`);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as StoredSession;
	} catch {
		return null;
	}
}

export async function saveSession(
	env: Env,
	sessionId: string,
	session: StoredSession,
): Promise<void> {
	await env.SESSIONS.put(`session:${sessionId}`, JSON.stringify(session), {
		expirationTtl: SESSION_TTL_SECONDS,
	});
}

export async function deleteSession(
	env: Env,
	sessionId: string | null,
): Promise<void> {
	if (!sessionId) return;
	await env.SESSIONS.delete(`session:${sessionId}`);
}
