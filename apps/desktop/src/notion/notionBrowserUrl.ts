import { parseNotionDatabaseMetadata } from "./notionDatabase";
import { parseNotionLinkMetadata } from "./notionMarkdown";

export function notionBrowserUrlForMarkdown(markdown: string): string | null {
	return (
		parseNotionLinkMetadata(markdown)?.url ??
		parseNotionDatabaseMetadata(markdown)?.url ??
		null
	);
}
