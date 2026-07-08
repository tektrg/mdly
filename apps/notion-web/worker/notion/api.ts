// Thin server-side Notion REST client. Holds the OAuth access token and the
// API version; the browser never sees the token. Replaces the desktop app's
// `ntn-acct` CLI (which wrapped these same endpoints).

const NOTION_BASE = "https://api.notion.com";

export class NotionApiError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
	) {
		super(message);
		this.name = "NotionApiError";
	}
}

type NotionClientOptions = {
	accessToken: string;
	apiVersion: string;
};

async function notionFetch(
	options: NotionClientOptions,
	path: string,
	init: RequestInit & { json?: unknown } = {},
): Promise<unknown> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${options.accessToken}`);
	headers.set("Notion-Version", options.apiVersion);
	let body = init.body;
	if (init.json !== undefined) {
		headers.set("Content-Type", "application/json");
		body = JSON.stringify(init.json);
	}

	const response = await fetch(`${NOTION_BASE}${path}`, {
		...init,
		headers,
		body,
	});

	const text = await response.text();
	let parsed: unknown = null;
	if (text) {
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = text;
		}
	}

	if (!response.ok) {
		const errorObject =
			parsed && typeof parsed === "object"
				? (parsed as Record<string, unknown>)
				: {};
		const code =
			typeof errorObject.code === "string" ? errorObject.code : "notion_error";
		const message =
			typeof errorObject.message === "string"
				? errorObject.message
				: `Notion API error (${response.status})`;
		throw new NotionApiError(response.status, code, message);
	}

	return parsed;
}

export async function fetchNotionUser(
	options: NotionClientOptions,
): Promise<unknown> {
	return notionFetch(options, "/v1/users/me", { method: "GET" });
}

export async function searchNotion(
	options: NotionClientOptions,
	query: string,
	pageSize = 20,
): Promise<unknown> {
	return notionFetch(options, "/v1/search", {
		method: "POST",
		json: {
			query,
			page_size: pageSize,
			sort: { direction: "descending", timestamp: "last_edited_time" },
		},
	});
}

export type PageMarkdown = {
	markdown: string;
	truncated: boolean;
};

export async function fetchPageMarkdown(
	options: NotionClientOptions,
	pageId: string,
): Promise<PageMarkdown> {
	const parsed = notionMarkdownContent(
		await notionFetch(options, `/v1/pages/${pageId}/markdown`, {
			method: "GET",
		}),
	);
	return parsed;
}

export async function patchPageMarkdown(
	options: NotionClientOptions,
	pageId: string,
	body: unknown,
): Promise<void> {
	await notionFetch(options, `/v1/pages/${pageId}/markdown`, {
		method: "PATCH",
		json: body,
	});
}

export async function replacePageMarkdown(
	options: NotionClientOptions,
	pageId: string,
	markdown: string,
): Promise<void> {
	await notionFetch(options, `/v1/pages/${pageId}/markdown`, {
		method: "PATCH",
		json: {
			type: "replace_content",
			replace_content: { new_str: markdown },
		},
	});
}

export async function queryNotionSource(
	options: NotionClientOptions,
	sourceId: string,
	object: "database" | "data_source",
	pageSize = 50,
	startCursor?: string | null,
): Promise<unknown> {
	const path =
		object === "data_source"
			? `/v1/data_sources/${sourceId}/query`
			: `/v1/databases/${sourceId}/query`;
	const json: Record<string, unknown> = {
		page_size: Math.min(Math.max(pageSize, 1), 100),
	};
	if (startCursor) json.start_cursor = startCursor;
	return notionFetch(options, path, { method: "POST", json });
}

function notionMarkdownContent(parsed: unknown): PageMarkdown {
	const object =
		parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: {};
	const markdown =
		typeof object.content === "string"
			? object.content
			: typeof object.markdown === "string"
				? object.markdown
				: "";
	return {
		markdown: markdown.trimEnd(),
		truncated: object.truncated === true,
	};
}
