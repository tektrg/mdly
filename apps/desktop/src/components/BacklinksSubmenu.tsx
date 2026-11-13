import { Menu } from "@base-ui/react/menu";
import { useStoreValue } from "@simplestack/store/react";
import { useMemo } from "react";
import MingcuteLinkLine from "~icons/mingcute/link-line";
import MingcuteRightLine from "~icons/mingcute/right-line";
import { backlinkMenuEntries } from "../lib/backlinkMenu";
import { backlinksFor } from "../lib/linkIndex";
import { loadPath } from "../store/actions";
import { currentLinkIndex, linkIndexStore } from "../store/linkIndexStore";
import { workspacePathStore } from "../store/state";
import { useLinkIndexSync } from "../store/useLinkIndexSync";

/** Rows shown before the list scrolls (every entry stays reachable). */
export const BACKLINKS_MENU_VISIBLE_ITEMS = 15;

const ITEM_CLASS =
	"flex w-full cursor-pointer items-center gap-2 rounded-mdly-control [padding-block:0.375rem] [padding-inline:0.5rem] text-start text-[11px] outline-hidden select-none data-highlighted:bg-accent data-disabled:cursor-default data-disabled:text-muted-foreground";

/**
 * "Backlinks (N)" submenu for the note's ⋯ menu. Mounting it (the menu
 * opening) starts the link index sync, so the list is never stale.
 */
export function BacklinksSubmenu({ path }: { path: string }) {
	useLinkIndexSync(true);
	const workspacePath = useStoreValue(workspacePathStore);
	const { status, version } = useStoreValue(linkIndexStore);
	const pending = status === "indexing" || status === "idle";

	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the change signal for the mutable index.
	const entries = useMemo(
		() =>
			backlinkMenuEntries(
				backlinksFor(currentLinkIndex(), path).map((link) => link.sourcePath),
				workspacePath ?? null,
			),
		[path, version, workspacePath],
	);

	return (
		<Menu.SubmenuRoot>
			<Menu.SubmenuTrigger className={ITEM_CLASS}>
				<MingcuteLinkLine className="size-3 shrink-0" />
				<span className="min-w-0 flex-1">
					{pending ? "Backlinks" : `Backlinks (${entries.length})`}
				</span>
				<MingcuteRightLine className="size-3 shrink-0 text-muted-foreground" />
			</Menu.SubmenuTrigger>
			<Menu.Portal>
				<Menu.Positioner
					className="z-50"
					side="left"
					align="start"
					sideOffset={4}
				>
					<Menu.Popup className="w-56 origin-(--transform-origin) rounded-[18px] bg-popover shadow-overlay p-1 text-[11px] text-popover-foreground outline-hidden">
						{pending ? (
							<Menu.Item disabled className={ITEM_CLASS}>
								Scanning links…
							</Menu.Item>
						) : status === "failed" ? (
							<Menu.Item disabled className={ITEM_CLASS}>
								Couldn't read links
							</Menu.Item>
						) : entries.length === 0 ? (
							<Menu.Item disabled className={ITEM_CLASS}>
								No backlinks
							</Menu.Item>
						) : (
							<div
								data-backlink-list
								className="overflow-y-auto"
								// ~28px per row: cap the height, scroll the rest.
								style={{
									maxBlockSize: `${BACKLINKS_MENU_VISIBLE_ITEMS * 28}px`,
								}}
							>
								{entries.map((entry) => (
									<Menu.Item
										key={entry.path}
										data-backlink-item
										title={entry.title}
										className={ITEM_CLASS}
										onClick={() => void loadPath(entry.path)}
									>
										<span className="min-w-0 flex-1 truncate">
											{entry.label}
										</span>
									</Menu.Item>
								))}
							</div>
						)}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.SubmenuRoot>
	);
}
