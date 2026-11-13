/**
 * Curated saved-view icons (Mingcute "-line" set, the app's icon library),
 * stored in `.hubble/views.json` as the record's top-level `icon` (the name
 * below). Mirrors FastTab's custom-view icon set, widened to ~95 with
 * categories and search keywords. Data only: the CLI (`packages/cli/src/viewIcons.ts`)
 * and the MCP tools validate against the same names (parity test).
 */
export type SavedViewIconInfo = {
	name: string;
	category: string;
	keywords: string;
};

export const DEFAULT_SAVED_VIEW_ICON = "bookmark";

export const SAVED_VIEW_ICONS: readonly SavedViewIconInfo[] = [
	{
		name: "bookmark",
		category: "Organize",
		keywords: "bookmark saved default",
	},
	{
		name: "layers",
		category: "Organize",
		keywords: "stack layers default view all",
	},
	{ name: "folder", category: "Organize", keywords: "folder directory" },
	{
		name: "folder-open",
		category: "Organize",
		keywords: "folder open directory",
	},
	{ name: "inbox", category: "Organize", keywords: "inbox incoming triage" },
	{ name: "archive", category: "Organize", keywords: "archive old done" },
	{ name: "box", category: "Organize", keywords: "box package storage" },
	{ name: "tag", category: "Organize", keywords: "tag label" },
	{ name: "hashtag", category: "Organize", keywords: "hashtag topic" },
	{ name: "pin", category: "Organize", keywords: "pin pinned" },
	{ name: "star", category: "Organize", keywords: "star favorite" },
	{ name: "heart", category: "Organize", keywords: "heart love favorite" },
	{ name: "flag-1", category: "Organize", keywords: "flag priority mark" },
	{
		name: "list-check",
		category: "Organize",
		keywords: "list todo tasks checklist",
	},
	{
		name: "check-circle",
		category: "Organize",
		keywords: "check done complete",
	},
	{ name: "task", category: "Organize", keywords: "task todo" },
	{ name: "clipboard", category: "Organize", keywords: "clipboard tasks" },
	{ name: "grid", category: "Organize", keywords: "grid board all" },
	{ name: "time", category: "Time", keywords: "time clock recent" },
	{ name: "calendar", category: "Time", keywords: "calendar date schedule" },
	{ name: "alarm-1", category: "Time", keywords: "alarm reminder" },
	{
		name: "bell-ringing",
		category: "Time",
		keywords: "bell notification reminder",
	},
	{ name: "briefcase", category: "Work", keywords: "briefcase work job" },
	{ name: "building-1", category: "Work", keywords: "building office company" },
	{ name: "chart-bar", category: "Work", keywords: "chart bar stats metrics" },
	{ name: "chart-line", category: "Work", keywords: "chart line trend" },
	{ name: "chart-pie", category: "Work", keywords: "chart pie report" },
	{ name: "target", category: "Work", keywords: "target goal okr" },
	{ name: "trophy", category: "Work", keywords: "trophy win achievement" },
	{ name: "rocket", category: "Work", keywords: "rocket launch ship" },
	{ name: "coin", category: "Work", keywords: "coin money finance budget" },
	{ name: "wallet-4", category: "Work", keywords: "wallet money finance" },
	{ name: "bank", category: "Work", keywords: "bank finance" },
	{ name: "mail", category: "Work", keywords: "mail email" },
	{ name: "chat-1", category: "Work", keywords: "chat message discussion" },
	{ name: "phone", category: "Work", keywords: "phone call" },
	{ name: "user-3", category: "Work", keywords: "user person people" },
	{ name: "group", category: "Work", keywords: "group team people" },
	{ name: "file", category: "Docs", keywords: "file document" },
	{ name: "document", category: "Docs", keywords: "document doc page" },
	{ name: "document-2", category: "Docs", keywords: "document doc spec" },
	{ name: "book", category: "Docs", keywords: "book reading" },
	{ name: "book-2", category: "Docs", keywords: "book reading library" },
	{ name: "notebook", category: "Docs", keywords: "notebook notes journal" },
	{ name: "news", category: "Docs", keywords: "news newspaper article" },
	{ name: "pen", category: "Docs", keywords: "pen write draft" },
	{ name: "edit", category: "Docs", keywords: "edit write draft" },
	{ name: "paper", category: "Docs", keywords: "paper page" },
	{ name: "translate", category: "Docs", keywords: "translate language" },
	{
		name: "school",
		category: "Docs",
		keywords: "school education learning graduationcap",
	},
	{ name: "code", category: "Tech", keywords: "code developer programming" },
	{ name: "terminal-box", category: "Tech", keywords: "terminal shell cli" },
	{ name: "git-branch", category: "Tech", keywords: "git branch" },
	{ name: "bug", category: "Tech", keywords: "bug issue" },
	{ name: "tool", category: "Tech", keywords: "tool hammer build" },
	{ name: "settings-3", category: "Tech", keywords: "settings config" },
	{ name: "key-2", category: "Tech", keywords: "key secret access" },
	{ name: "lock", category: "Tech", keywords: "lock private secure" },
	{ name: "shield", category: "Tech", keywords: "shield security" },
	{ name: "ai", category: "Tech", keywords: "ai agent" },
	{ name: "brain", category: "Tech", keywords: "brain ideas memory" },
	{ name: "sparkles", category: "Tech", keywords: "sparkles magic ai" },
	{ name: "link", category: "Tech", keywords: "link url" },
	{ name: "search", category: "Tech", keywords: "search find" },
	{ name: "eye", category: "Tech", keywords: "eye watch review" },
	{ name: "movie", category: "Media", keywords: "movie film video" },
	{ name: "music", category: "Media", keywords: "music song audio" },
	{
		name: "microphone",
		category: "Media",
		keywords: "microphone podcast audio",
	},
	{ name: "headphone", category: "Media", keywords: "headphone audio listen" },
	{ name: "camera-2", category: "Media", keywords: "camera photo" },
	{ name: "pic", category: "Media", keywords: "picture image photo" },
	{ name: "palette", category: "Media", keywords: "palette design color" },
	{
		name: "paint-brush",
		category: "Media",
		keywords: "paint brush design art",
	},
	{ name: "game-2", category: "Media", keywords: "game play" },
	{ name: "home-4", category: "Life", keywords: "home house personal" },
	{ name: "earth", category: "Life", keywords: "earth globe world web" },
	{ name: "map-pin", category: "Life", keywords: "map pin location place" },
	{ name: "compass", category: "Life", keywords: "compass explore" },
	{ name: "airplane", category: "Life", keywords: "airplane travel trip" },
	{ name: "car", category: "Life", keywords: "car drive" },
	{ name: "fork-knife", category: "Life", keywords: "food recipe restaurant" },
	{ name: "teacup", category: "Life", keywords: "tea coffee cup" },
	{ name: "cake", category: "Life", keywords: "cake birthday" },
	{ name: "gift", category: "Life", keywords: "gift present" },
	{ name: "shopping-cart-1", category: "Life", keywords: "shopping cart buy" },
	{ name: "leaf", category: "Life", keywords: "leaf nature plant" },
	{ name: "sun", category: "Life", keywords: "sun day weather" },
	{ name: "moon", category: "Life", keywords: "moon night" },
	{ name: "cloud", category: "Life", keywords: "cloud weather" },
	{ name: "fire", category: "Symbols", keywords: "fire hot urgent" },
	{
		name: "flash",
		category: "Symbols",
		keywords: "flash bolt lightning quick",
	},
	{ name: "light", category: "Symbols", keywords: "light bulb idea" },
	{ name: "diamond", category: "Symbols", keywords: "diamond gem" },
	{ name: "planet", category: "Symbols", keywords: "planet space" },
	{ name: "thumb-up", category: "Symbols", keywords: "thumb up like" },
];

export const SAVED_VIEW_ICON_NAMES: readonly string[] = SAVED_VIEW_ICONS.map(
	(icon) => icon.name,
);

const NAME_SET = new Set(SAVED_VIEW_ICON_NAMES);

export function isSavedViewIconName(value: unknown): value is string {
	return typeof value === "string" && NAME_SET.has(value);
}

/** The icon to draw: the stored name when known, else the default (unknown/newer names fall back). */
export function resolveSavedViewIcon(icon: unknown): string {
	return isSavedViewIconName(icon) ? icon : DEFAULT_SAVED_VIEW_ICON;
}

/** Icons whose name, category or keywords contain every word of `query`. */
export function filterSavedViewIcons(query: string): SavedViewIconInfo[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [...SAVED_VIEW_ICONS];
	return SAVED_VIEW_ICONS.filter((icon) => {
		const hay = `${icon.name} ${icon.category} ${icon.keywords}`.toLowerCase();
		return words.every((word) => hay.includes(word));
	});
}
