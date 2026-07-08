export type Env = {
	/** Static SPA assets (Vite `dist`). */
	ASSETS: Fetcher;
	/** session-id -> stored Notion OAuth token (JSON). */
	SESSIONS: KVNamespace;

	NOTION_API_VERSION: string;
	NOTION_CLIENT_ID?: string;
	NOTION_CLIENT_SECRET?: string;
	/** Optional override; otherwise derived from the request origin. */
	NOTION_REDIRECT_URI?: string;
};

export type StoredSession = {
	accessToken: string;
	workspaceName: string | null;
	workspaceIcon: string | null;
	botId: string | null;
};
