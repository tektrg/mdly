import MingcuteFolderLine from "~icons/mingcute/folder-line";
import MingcuteTagLine from "~icons/mingcute/tag-line";
import MingcuteTimeLine from "~icons/mingcute/time-line";
import type { NavViewId } from "./navHiddenViews";

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
