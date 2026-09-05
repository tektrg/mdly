import { env, SELF } from "cloudflare:test";

/** The shared test password wired up in vitest.config.ts's miniflare bindings. */
export const TEST_PASSWORD = "correct-horse-battery-staple";

function extractCookie(response: Response): string | null {
	const setCookie = response.headers.get("Set-Cookie");
	if (!setCookie) return null;
	return setCookie.split(";")[0] ?? null;
}

/** Logs in with the given password (defaults to the correct one) and returns the response plus the session cookie (null if none was set). */
export async function login(
	password: string = TEST_PASSWORD,
): Promise<{ response: Response; cookie: string | null }> {
	const response = await SELF.fetch("https://garden.test/api/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ password }),
	});
	return { response, cookie: extractCookie(response) };
}

export async function fetchWithCookie(
	path: string,
	cookie: string,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("Cookie", cookie);
	return SELF.fetch(`https://garden.test${path}`, { ...init, headers });
}

export async function fetchWithBearer(
	path: string,
	init: RequestInit = {},
	token: string = TEST_PASSWORD,
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${token}`);
	return SELF.fetch(`https://garden.test${path}`, { ...init, headers });
}

export async function fetchNoAuth(
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	return SELF.fetch(`https://garden.test${path}`, init);
}

export function jsonBody(data: unknown): RequestInit {
	return {
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(data),
	};
}

/** A ready-to-use authenticated JSON POST/GET helper (bearer, since it needs no cookie plumbing across calls). */
export async function authedJson<T>(
	path: string,
	init: RequestInit = {},
): Promise<{ status: number; body: T }> {
	const response = await fetchWithBearer(path, init);
	const body = (await response.json().catch(() => null)) as T;
	return { status: response.status, body };
}

export function workspaceDoStub(workspaceId: string) {
	const id = env.WORKSPACE_DO.idFromName(workspaceId);
	return env.WORKSPACE_DO.get(id);
}
