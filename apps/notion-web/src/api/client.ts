import type {
	NotionDatabaseQueryResult,
	NotionSearchResult,
	SessionStatus,
} from "../notion/types";

class ApiError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export function isNotConnected(error: unknown): boolean {
	return error instanceof ApiError && error.status === 401;
}

async function request<T>(
	input: string,
	init: RequestInit = {},
): Promise<T> {
	const response = await fetch(input, {
		credentials: "same-origin",
		...init,
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
		const message =
			parsed && typeof parsed === "object" && "error" in parsed
				? String((parsed as { error: unknown }).error)
				: `Request failed (${response.status})`;
		throw new ApiError(response.status, message);
	}
	return parsed as T;
}

export function getSessionStatus(): Promise<SessionStatus> {
	return request<SessionStatus>("/api/session");
}

export function searchNotion(query: string): Promise<NotionSearchResult[]> {
	return request<{ results: NotionSearchResult[] }>(
		`/api/notion/search?q=${encodeURIComponent(query)}`,
	).then((data) => data.results);
}

export function getPageMarkdown(
	pageId: string,
): Promise<{ markdown: string; truncated: boolean }> {
	return request(`/api/notion/page/${encodeURIComponent(pageId)}/markdown`);
}

export type UpdatePageResult = {
	ok: true;
	mode: "noop" | "targeted" | "replace" | "replace-fallback";
};

export function updatePageMarkdown(
	pageId: string,
	payload: {
		nextMarkdown: string;
		previousMarkdown?: string;
		currentMarkdown?: string;
	},
): Promise<UpdatePageResult> {
	return request(`/api/notion/page/${encodeURIComponent(pageId)}/markdown`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
}

export function queryDatabase(
	sourceId: string,
	object: "database" | "data_source",
	startCursor?: string | null,
): Promise<NotionDatabaseQueryResult> {
	return request("/api/notion/database/query", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ sourceId, object, startCursor }),
	});
}

export function logout(): Promise<void> {
	return request("/auth/logout", { method: "POST" }).then(() => undefined);
}
