import type { Env } from "./env";
import {
	NotionApiError,
	fetchNotionUser,
	fetchPageMarkdown,
	patchPageMarkdown,
	queryNotionSource,
	replacePageMarkdown,
	searchNotion,
} from "./notion/api";
import {
	authorizeUrl,
	exchangeCodeForToken,
	notionConfigured,
} from "./notion/oauth";
import {
	notionMarkdownPatchBody,
	notionMarkdownUpdatePayload,
	shouldFallbackToFullNotionMarkdownUpdate,
} from "./notion/markdownUpdate";
import { parseDatabaseRows, parseSearchResults } from "./notion/parse";
import {
	deleteSession,
	isSecureRequest,
	loadSession,
	newOAuthState,
	newSessionId,
	oauthStateClearCookie,
	oauthStateCookieValue,
	oauthStateSetCookie,
	saveSession,
	sessionClearCookie,
	sessionCookieValue,
	sessionSetCookie,
} from "./session";

function json(data: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("Content-Type", "application/json");
	return new Response(JSON.stringify(data), { ...init, headers });
}

function notionErrorResponse(error: unknown): Response {
	if (error instanceof NotionApiError) {
		const status = error.status === 401 ? 401 : 502;
		return json({ error: error.message, code: error.code }, { status });
	}
	const message = error instanceof Error ? error.message : String(error);
	return json({ error: message }, { status: 500 });
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		try {
			if (path.startsWith("/auth/")) {
				return await handleAuth(request, env, url);
			}
			if (path.startsWith("/api/")) {
				return await handleApi(request, env, url);
			}
		} catch (error) {
			return notionErrorResponse(error);
		}

		// Not an API/auth route — serve the SPA assets.
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;

async function handleAuth(
	request: Request,
	env: Env,
	url: URL,
): Promise<Response> {
	const secure = isSecureRequest(request);

	if (url.pathname === "/auth/notion/start" && request.method === "GET") {
		if (!notionConfigured(env)) {
			return redirectTo("/?error=not_configured", []);
		}
		const state = newOAuthState();
		return redirectTo(authorizeUrl(env, request, state), [
			oauthStateSetCookie(state, secure),
		]);
	}

	if (url.pathname === "/auth/notion/callback" && request.method === "GET") {
		const error = url.searchParams.get("error");
		if (error) {
			return redirectTo(`/?error=${encodeURIComponent(error)}`, [
				oauthStateClearCookie(secure),
			]);
		}

		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		const expectedState = oauthStateCookieValue(request);
		if (!code || !state || !expectedState || state !== expectedState) {
			return redirectTo("/?error=invalid_state", [
				oauthStateClearCookie(secure),
			]);
		}

		const session = await exchangeCodeForToken(env, request, code);
		const sessionId = newSessionId();
		await saveSession(env, sessionId, session);
		return redirectTo("/", [
			oauthStateClearCookie(secure),
			sessionSetCookie(sessionId, secure),
		]);
	}

	if (url.pathname === "/auth/logout" && request.method === "POST") {
		const sessionId = sessionCookieValue(request);
		await deleteSession(env, sessionId);
		return json({ ok: true }, { headers: { "Set-Cookie": sessionClearCookie(secure) } });
	}

	return json({ error: "Not found" }, { status: 404 });
}

async function handleApi(
	request: Request,
	env: Env,
	url: URL,
): Promise<Response> {
	const sessionId = sessionCookieValue(request);
	const session = await loadSession(env, sessionId);

	// Connection status is readable without a session (returns connected:false).
	if (url.pathname === "/api/session" && request.method === "GET") {
		return json({
			connected: Boolean(session),
			configured: notionConfigured(env),
			workspaceName: session?.workspaceName ?? null,
			workspaceIcon: session?.workspaceIcon ?? null,
		});
	}

	if (!session) {
		return json({ error: "Not connected to Notion." }, { status: 401 });
	}

	const client = {
		accessToken: session.accessToken,
		apiVersion: env.NOTION_API_VERSION,
	};

	// Validate the token is still good (used by the app on load).
	if (url.pathname === "/api/notion/me" && request.method === "GET") {
		const user = await fetchNotionUser(client);
		return json({ user });
	}

	if (url.pathname === "/api/notion/search" && request.method === "GET") {
		const query = url.searchParams.get("q")?.trim() ?? "";
		if (!query) return json({ results: [] });
		const raw = await searchNotion(client, query);
		return json({ results: parseSearchResults(raw) });
	}

	const pageMatch = url.pathname.match(
		/^\/api\/notion\/page\/([^/]+)\/markdown$/,
	);
	if (pageMatch) {
		const pageId = decodeURIComponent(pageMatch[1] ?? "");
		if (request.method === "GET") {
			const page = await fetchPageMarkdown(client, pageId);
			return json(page);
		}
		if (request.method === "PATCH") {
			return updatePage(request, client, pageId);
		}
	}

	if (
		url.pathname === "/api/notion/database/query" &&
		request.method === "POST"
	) {
		const body = (await request.json().catch(() => ({}))) as {
			sourceId?: string;
			object?: "database" | "data_source";
			startCursor?: string | null;
		};
		if (!body.sourceId) {
			return json({ error: "sourceId is required." }, { status: 400 });
		}
		const raw = await queryNotionSource(
			client,
			body.sourceId,
			body.object === "data_source" ? "data_source" : "database",
			50,
			body.startCursor ?? null,
		);
		return json(parseDatabaseRows(raw));
	}

	return json({ error: "Not found" }, { status: 404 });
}

async function updatePage(
	request: Request,
	client: { accessToken: string; apiVersion: string },
	pageId: string,
): Promise<Response> {
	const body = (await request.json().catch(() => ({}))) as {
		nextMarkdown?: string;
		previousMarkdown?: string;
		currentMarkdown?: string;
	};
	const nextMarkdown = body.nextMarkdown ?? "";

	const payload = notionMarkdownUpdatePayload({
		previousMarkdown: body.previousMarkdown,
		currentMarkdown: body.currentMarkdown,
		nextMarkdown,
	});

	if (payload.kind === "noop") {
		return json({ ok: true, mode: "noop" });
	}

	if (payload.kind === "targeted") {
		try {
			await patchPageMarkdown(client, pageId, notionMarkdownPatchBody(payload));
			return json({ ok: true, mode: "targeted" });
		} catch (error) {
			if (
				!shouldFallbackToFullNotionMarkdownUpdate(error, {
					previousMarkdown: body.previousMarkdown,
					currentMarkdown: body.currentMarkdown,
					nextMarkdown,
				})
			) {
				throw error;
			}
			await replacePageMarkdown(client, pageId, nextMarkdown);
			return json({ ok: true, mode: "replace-fallback" });
		}
	}

	await replacePageMarkdown(client, pageId, nextMarkdown);
	return json({ ok: true, mode: "replace" });
}

function redirectTo(location: string, cookies: string[]): Response {
	const headers = new Headers({ Location: location });
	for (const cookie of cookies) headers.append("Set-Cookie", cookie);
	return new Response(null, { status: 302, headers });
}
