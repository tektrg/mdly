import MingcuteFolderLine from "~icons/mingcute/folder-line";
import MingcuteTagLine from "~icons/mingcute/tag-line";
import MingcuteTimeLine from "~icons/mingcute/time-line";
import type { NavViewId } from "./navHiddenViews";
import type { NavSwitcherEntry } from "./navSwitcherEntries";
import { SavedViewIconGlyph } from "./SavedViewIconGlyph";

export const NAV_VIEW_LABEL: Record<NavViewId, string> = {
	recent: "Recent",
	folder: "Folder",
	tag: "Tag",
};

export function NavViewIcon({ view }: { view: NavViewId }) {
	const Icon =
		view === "recent"
			? MingcuteTimeLine
			: view === "folder"
				? MingcuteFolderLine
				: MingcuteTagLine;
	return <Icon aria-hidden="true" className="size-3.5" />;
}

/** A switcher entry's icon: the built-in's own, or the saved view's chosen icon. */
export function NavEntryIcon({ entry }: { entry: NavSwitcherEntry }) {
	return entry.kind === "builtin" ? (
		<NavViewIcon view={entry.view} />
	) : (
		<SavedViewIconGlyph icon={entry.icon} />
	);
}

export function navEntryLabel(entry: NavSwitcherEntry): string {
	return entry.kind === "builtin" ? NAV_VIEW_LABEL[entry.view] : entry.name;
}
