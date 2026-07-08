import type { Env, StoredSession } from "../env";

export function notionConfigured(env: Env): boolean {
	return Boolean(env.NOTION_CLIENT_ID && env.NOTION_CLIENT_SECRET);
}

export function redirectUri(env: Env, request: Request): string {
	if (env.NOTION_REDIRECT_URI) return env.NOTION_REDIRECT_URI;
	const url = new URL(request.url);
	return `${url.origin}/auth/notion/callback`;
}

export function authorizeUrl(
	env: Env,
	request: Request,
	state: string,
): string {
	const url = new URL("https://api.notion.com/v1/oauth/authorize");
	url.searchParams.set("client_id", env.NOTION_CLIENT_ID ?? "");
	url.searchParams.set("response_type", "code");
	url.searchParams.set("owner", "user");
	url.searchParams.set("redirect_uri", redirectUri(env, request));
	url.searchParams.set("state", state);
	return url.toString();
}

export async function exchangeCodeForToken(
	env: Env,
	request: Request,
	code: string,
): Promise<StoredSession> {
	const credentials = btoa(
		`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`,
	);
	const response = await fetch("https://api.notion.com/v1/oauth/token", {
		method: "POST",
		headers: {
			Authorization: `Basic ${credentials}`,
			"Content-Type": "application/json",
			"Notion-Version": env.NOTION_API_VERSION,
		},
		body: JSON.stringify({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri(env, request),
		}),
	});

	const text = await response.text();
	let parsed: Record<string, unknown> = {};
	try {
		parsed = JSON.parse(text) as Record<string, unknown>;
	} catch {
		parsed = {};
	}

	if (!response.ok || typeof parsed.access_token !== "string") {
		const message =
			typeof parsed.error_description === "string"
				? parsed.error_description
				: typeof parsed.error === "string"
					? parsed.error
					: `Notion token exchange failed (${response.status})`;
		throw new Error(message);
	}

	return {
		accessToken: parsed.access_token,
		workspaceName:
			typeof parsed.workspace_name === "string"
				? parsed.workspace_name
				: null,
		workspaceIcon:
			typeof parsed.workspace_icon === "string"
				? parsed.workspace_icon
				: null,
		botId: typeof parsed.bot_id === "string" ? parsed.bot_id : null,
	};
}
