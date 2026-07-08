export type NotionObjectType = "page" | "database" | "data_source";

export type NotionSearchResult = {
	id: string;
	object: NotionObjectType;
	title: string;
	url: string | null;
	lastEditedTime: string | null;
};

export type NotionDatabaseRow = {
	pageId: string;
	title: string;
	url: string | null;
	lastEditedTime: string | null;
	properties: Record<string, string>;
};

export type NotionDatabaseQueryResult = {
	columns: string[];
	rows: NotionDatabaseRow[];
	hasMore: boolean;
	nextCursor: string | null;
};

export type SessionStatus = {
	connected: boolean;
	configured: boolean;
	workspaceName: string | null;
	workspaceIcon: string | null;
};
