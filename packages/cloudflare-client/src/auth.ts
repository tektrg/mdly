/**
 * Two credential shapes, matching the Worker's `auth.ts` middleware exactly
 * (R38 — one shared password, presented two ways):
 *  - `cookie`: a browser. The session cookie is set by `/api/login` and sent
 *    automatically by the browser on every same-origin request (fetch,
 *    `<img>`, and — per the WebSocket handshake spec — the socket upgrade
 *    too). No header for this client to add itself.
 *  - `bearer`: the desktop app or the CLI (R3 — never register a device
 *    slot, authenticate by bearer token only). `token` is the shared
 *    password itself in Stage 1/3 (see apps/www/worker/auth.ts's own
 *    comment on this — Keychain-backed per-device tokens are Stage 4).
 */
export type CloudflareAuth =
	| { kind: "cookie" }
	| { kind: "bearer"; token: string };

export function authHeaders(auth: CloudflareAuth): Record<string, string> {
	return auth.kind === "bearer"
		? { Authorization: `Bearer ${auth.token}` }
		: {};
}

/** Cookie-mode requests must carry the session cookie; browsers do this by default for same-origin fetches, but we set it explicitly so behavior doesn't depend on a runtime default. */
export function authFetchInit(auth: CloudflareAuth): RequestInit {
	return auth.kind === "cookie" ? { credentials: "same-origin" } : {};
}
