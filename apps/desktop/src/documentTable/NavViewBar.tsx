import { type DragEvent, useState } from "react";
import { cn } from "../lib/utils";
import { reorderSavedViews } from "./documentTableStore";
import { NavEntryIcon, navEntryLabel } from "./NavViewIcon";
import type { NavSwitcherEntry } from "./navSwitcherEntries";
import { SavedViewNameInput } from "./SavedViewControls";
import { useNavViewSwitcher } from "./useNavViewSwitcher";
import { useSavedViewMenus } from "./useSavedViewMenus";
import { WINDOW_CHROME_INSET_CLASS } from "./windowChromeInset";

const DRAG_TYPE = "application/x-mdly-saved-view";

/**
 * Settings → Appearance "Show views as a left bar": every view (visible
 * built-ins, then saved views in file order) as an icon button down the
 * window's left edge, in every layout. Same entries, selection and right-click
 * behaviour as the list header's switcher, which hides while this is shown.
 * Saved views drag to reorder; built-ins keep their fixed order.
 */
export function NavViewBar() {
	// Every built-in shows (hidden ones dimmed): the bar replaces the strip, so
	// it must also be where a hidden view is restored (select it).
	const {
		activeKey,
		hidden,
		inlineEntries: entries,
		selectEntry,
		selectInline,
		toggleHidden,
	} = useNavViewSwitcher();
	const { openSavedViewMenu, renaming, menus } = useSavedViewMenus(entries);
	const [dragId, setDragId] = useState<string | null>(null);
	const [dropBefore, setDropBefore] = useState<string | null>(null);
	const [renameAnchor, setRenameAnchor] = useState<DOMRect | null>(null);

	const savedIds = entries.flatMap((entry) =>
		entry.kind === "saved" ? [entry.id] : [],
	);

	/** The saved view the dragged one lands before: the hovered one, or the next one in its lower half. */
	const dropTarget = (
		entry: NavSwitcherEntry & { kind: "saved" },
		event: DragEvent<HTMLElement>,
	): string | null => {
		const rect = event.currentTarget.getBoundingClientRect();
		const lowerHalf =
			rect.height > 0 && event.clientY > rect.top + rect.height / 2;
		if (!lowerHalf) return entry.id;
		return savedIds[savedIds.indexOf(entry.id) + 1] ?? null;
	};

	return (
		<nav
			aria-label="Views"
			data-nav-view-bar
			className={cn(
				"flex w-11 shrink-0 flex-col items-center gap-1 overflow-y-auto border-e border-border/60 bg-sidebar [padding-block-end:0.5rem]",
				WINDOW_CHROME_INSET_CLASS,
			)}
		>
			{entries.map((entry) => {
				const isActive = activeKey === entry.key;
				const label = navEntryLabel(entry);
				const saved = entry.kind === "saved" ? entry : null;
				const isHidden =
					entry.kind === "builtin" &&
					entry.view !== "recent" &&
					hidden.includes(entry.view);
				return (
					<button
						key={entry.key}
						type="button"
						data-nav-view-bar-option={entry.key}
						aria-pressed={isActive}
						aria-label={`${label} view`}
						title={
							isHidden ? `${label} (hidden — click to restore)` : label
						}
						draggable={saved !== null}
						className={cn(
							"relative flex size-8 shrink-0 items-center justify-center rounded-mdly-control outline-hidden transition-[background-color,color] duration-150 ease-snappy focus-visible:ring-[3px] focus-visible:ring-mdly-ink/20 motion-reduce:transition-none",
							isActive
								? "bg-selected text-selected-foreground"
								: "text-muted-foreground hover:bg-accent hover:text-foreground",
							saved && dragId === saved.id && "opacity-50",
							isHidden && !isActive && "opacity-50",
							saved &&
								dragId !== null &&
								dropBefore === saved.id &&
								"before:absolute before:inset-x-1 before:-top-0.5 before:h-0.5 before:rounded-full before:bg-mdly-ink before:content-['']",
						)}
						onClick={() =>
							entry.kind === "builtin"
								? selectInline(entry.view)
								: selectEntry(entry)
						}
						onContextMenu={(event) => {
							event.preventDefault();
							if (saved) {
								setRenameAnchor(event.currentTarget.getBoundingClientRect());
								openSavedViewMenu(saved.id, event.currentTarget);
							} else if (entry.kind === "builtin" && entry.view !== "recent") {
								toggleHidden(entry.view);
							}
						}}
						onDragStart={(event) => {
							if (!saved) return;
							event.dataTransfer.effectAllowed = "move";
							event.dataTransfer.setData(DRAG_TYPE, saved.id);
							setDragId(saved.id);
						}}
						onDragOver={(event) => {
							if (!saved || dragId === null) return;
							event.preventDefault();
							event.dataTransfer.dropEffect = "move";
							setDropBefore(dropTarget(saved, event));
						}}
						onDrop={(event) => {
							if (!saved) return;
							event.preventDefault();
							const id = event.dataTransfer.getData(DRAG_TYPE) || dragId;
							if (id) reorderSavedViews(id, dropTarget(saved, event));
							setDragId(null);
							setDropBefore(null);
						}}
						onDragEnd={() => {
							setDragId(null);
							setDropBefore(null);
						}}
					>
						<NavEntryIcon entry={entry} />
					</button>
				);
			})}
			{renaming ? (
				// No room in a 44px bar: the name box floats beside the renamed icon.
				<div
					className="fixed z-50 w-56 rounded-mdly-control bg-popover p-1 shadow-overlay"
					style={{
						insetInlineStart: (renameAnchor?.right ?? 44) + 4,
						insetBlockStart: renameAnchor?.top ?? 48,
					}}
				>
					<SavedViewNameInput
						className="flex min-w-0 flex-col"
						fill
						initialName={renaming.name}
						onCommit={renaming.commit}
						onCancel={renaming.cancel}
					/>
				</div>
			) : null}
			{menus}
		</nav>
	);
}
