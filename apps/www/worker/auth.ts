import type { Env } from "./env.js";
import {
	createConfirmedSession,
	deleteSession,
	isSecureRequest,
	loadSession,
	newSessionId,
	refreshSession,
	sessionClearCookie,
	sessionCookieValue,
	sessionSetCookie,
} from "./session.js";

/**
 * Auth middleware for every /api/* route (R40, R41, R43, R50).
 *
 * Two credential shapes, matching the plan's "Auth" locked decision:
 *  - Browser: session cookie, set only after a correct password POST to
 *    /api/login. Slides forward on every authenticated request (R43/D4).
 *  - Mac app + CLI: `Authorization: Bearer <shared password>`. Stage 1 does
 *    not mint a separate per-device token (that plumbing — Keychain storage,
 *    a dedicated token endpoint — is desktop-wiring scope, Stage 4); the
 *    bearer credential IS the shared password itself, presented as a header
 *    instead of a cookie. This keeps "single user, one shared password"
 *    (R38) literally true for both credential shapes and needs no new
 *    secret-issuance flow yet. Flagged in the delivery report as a
 *    deliberate simplification for Stage 3/4 to build on, not a shortcut
 *    that skipped a requirement.
 *
 * A request with neither a valid cookie nor a valid bearer header must be
 * rejected identically to a request with an outright WRONG credential in
 * either slot — same generic 401 body, no Set-Cookie, nothing that lets a
 * caller distinguish "absent" from "wrong" (R40, R41).
 */

export type AuthResult =
	| { ok: true; via: "cookie"; sessionId: string }
	| { ok: true; via: "bearer" }
	| { ok: false };

const BEARER_PREFIX = "Bearer ";

function timingSafeEqual(a: string, b: string): boolean {
	const enc = new TextEncoder();
	const aBytes = enc.encode(a);
	const bBytes = enc.encode(b);
	// Constant-time-ish compare: always walk the longer length so the
	// password's actual length doesn't leak via early return timing.
	const length = Math.max(aBytes.length, bBytes.length);
	let diff = aBytes.length ^ bBytes.length;
	for (let i = 0; i < length; i++) {
		diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
	}
	return diff === 0;
}

/**
 * Fail CLOSED when the shared password is not configured.
 *
 * Without this, an unset/empty `APP_PASSWORD` makes the Worker WIDE OPEN:
 * `timingSafeEqual` compares the presented bearer token against an empty
 * string, so a request carrying a literally empty credential
 * (`Authorization: Bearer `) matches and is authenticated. Verified against a
 * local Worker run with no secret bound -- `GET /api/workspaces` returned 200.
 *
 * That state is reachable in practice: a first deploy before
 * `wrangler secret put APP_PASSWORD`, a deleted or rotated-away secret, or a
 * new environment created without it. Ordering discipline in a checklist is
 * not a safety mechanism, so refuse everything -- cookie sessions included,
 * since removing the password must also revoke sessions minted under it.
 *
 * Rejection is the SAME generic 401 as a wrong credential (R40/R41): a
 * distinct "not configured" response would tell an anonymous caller about
 * the deployment's state.
 */
function passwordConfigured(env: Env): boolean {
	return typeof env.APP_PASSWORD === "string" && env.APP_PASSWORD.length > 0;
}

function bearerToken(request: Request): string | null {
	const header = request.headers.get("Authorization");
	if (!header || !header.startsWith(BEARER_PREFIX)) return null;
	return header.slice(BEARER_PREFIX.length).trim();
}

export async function authenticate(
	request: Request,
	env: Env,
): Promise<AuthResult> {
	if (!passwordConfigured(env)) return { ok: false };

	const token = bearerToken(request);
	if (token !== null) {
		if (timingSafeEqual(token, env.APP_PASSWORD)) {
			return { ok: true, via: "bearer" };
		}
		return { ok: false };
	}

	const sessionId = sessionCookieValue(request);
	const session = await loadSession(env, sessionId);
	if (session && sessionId) {
		return { ok: true, via: "cookie", sessionId };
	}
	return { ok: false };
}

/** Generic, indistinguishable rejection body for R40/R41. */
export function unauthenticatedResponse(): Response {
	return new Response(null, { status: 401 });
}

/**
 * Wraps an authenticated handler: rejects with the generic 401 up front, and
 * on success refreshes the sliding cookie (R43) before returning the
 * handler's response untouched otherwise.
 */
export async function withAuth(
	request: Request,
	env: Env,
	handler: (auth: AuthResult) => Promise<Response>,
): Promise<Response> {
	const auth = await authenticate(request, env);
	if (!auth.ok) return unauthenticatedResponse();

	const response = await handler(auth);

	if (auth.via === "cookie") {
		await refreshSession(env, auth.sessionId);
		const headers = new Headers(response.headers);
		headers.append(
			"Set-Cookie",
			sessionSetCookie(auth.sessionId, isSecureRequest(request)),
		);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}
	return response;
}

export async function handleLogin(
	request: Request,
	env: Env,
): Promise<Response> {
	const body = (await request.json().catch(() => null)) as {
		password?: string;
	} | null;
	const password = body?.password ?? "";

	if (
		!passwordConfigured(env) ||
		!password ||
		!timingSafeEqual(password, env.APP_PASSWORD)
	) {
		// No Set-Cookie, no distinguishing detail (R41).
		return new Response(null, { status: 401 });
	}

	const sessionId = newSessionId();
	await createConfirmedSession(env, sessionId);

	return new Response(JSON.stringify({ ok: true }), {
		status: 200,
		headers: {
			"Content-Type": "application/json",
			"Set-Cookie": sessionSetCookie(sessionId, isSecureRequest(request)),
		},
	});
}

export async function handleLogout(
	request: Request,
	env: Env,
): Promise<Response> {
	const sessionId = sessionCookieValue(request);
	await deleteSession(env, sessionId);
	return new Response(JSON.stringify({ ok: true }), {
		status: 200,
		headers: {
			"Content-Type": "application/json",
			"Set-Cookie": sessionClearCookie(isSecureRequest(request)),
		},
	});
}
