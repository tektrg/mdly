// Ported from apps/desktop/src/fileActions.ts (notionPageIdFromUrl /
// normalizedNotionPageId). Notion keeps the 32-hex object id as the last
// path segment regardless of the workspace-slug segment or a trailing
// `?v=` view id, so a Notion link becomes a working mdly link by swapping
// only the domain — this scans for that same segment.
export function notionObjectIdFromPath(pathname: string): string | null {
	const segments = pathname.split("/").filter(Boolean);
	if (segments[0] !== "p") return null;
	for (let index = segments.length - 1; index >= 1; index -= 1) {
		const id = normalizedNotionObjectId(segments[index] ?? "");
		if (id) return id;
	}
	return null;
}

function normalizedNotionObjectId(value: string): string | null {
	const decoded = decodeURIComponent(value);
	const match = decoded.replace(/-/g, "").match(/([0-9a-f]{32})$/i);
	return match?.[1]?.toLowerCase() ?? null;
}
