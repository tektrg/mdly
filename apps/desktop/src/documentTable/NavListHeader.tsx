import { Button } from "@hubble.md/ui";
import { useStoreValue } from "@simplestack/store/react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import MingcuteAzSortAscendingLettersLine from "~icons/mingcute/az-sort-ascending-letters-line";
import MingcuteSortDescendingLine from "~icons/mingcute/sort-descending-line";
import { cn } from "../lib/utils";
import { workspacePathStore } from "../store/state";
import {
	deleteSavedView,
	documentTableViewStore,
	renameSavedView,
	setDocumentTableSort,
} from "./documentTableStore";
import { DEFAULT_NAV_VIEW_SORT } from "./documentTableView";
import { savedViewsStore } from "./documentViewsFileStore";
import { NavViewDots } from "./NavViewDots";
import { NavEntryIcon, navEntryLabel } from "./NavViewIcon";
import type { NavDensityTier } from "./navDensity";
import {
	describeNavViewSort,
	setNavViewSort,
	useNavViewSort,
} from "./navViewSort";
import { SavedViewContextMenu, SavedViewNameInput } from "./SavedViewControls";
import { useNavViewSwitcher } from "./useNavViewSwitcher";

/**
 * The strip above the list, at every density tier. Home of the sort control
 * since it moved out of the sidebar, plus the view switcher: inline buttons
 * (recent / folder / tag) everywhere except Rail, where A12 collapses it to the
 * sidebar pager's dot-tab strip — search and Pinned are never dots. The sort
 * control edits the current view's own persisted sort.
 */
export function NavListHeader({
	navTier = "table",
	variant = "strip",
	hasUnsavedChanges = false,
	trailing,
	end,
}: {
	navTier?: NavDensityTier;
	/**
	 * `tabs`: the wide table's top toolbar row — underlined tabs, a gold dot on
	 * the active tab while it has unsaved changes, and `trailing` (save controls).
	 */
	variant?: "strip" | "tabs";
	hasUnsavedChanges?: boolean;
	trailing?: ReactNode;
	/** Tabs variant: pushed to the row's far end, before the sort button. */
	end?: ReactNode;
}) {
	const isTabs = variant === "tabs";
	const workspacePath = useStoreValue(workspacePathStore) ?? null;
	const {
		activeView,
		activeKey,
		hidden,
		entries,
		inlineEntries,
		selectEntry,
		selectInline,
		toggleHidden,
		onWheel,
	} = useNavViewSwitcher();
	// Saved views R2: the right-clicked saved icon (menu anchor) and the one
	// being renamed in place of the switcher.
	const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(
		null,
	);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const savedName = (id: string | null) => {
		const entry = entries.find(
			(candidate) => candidate.kind === "saved" && candidate.id === id,
		);
		return entry ? navEntryLabel(entry) : "";
	};
	const openSavedViewMenu = (id: string, anchor: HTMLElement) =>
		setMenu({ id, anchor });
	// A saved view owns its sort: the button shows and edits it, never the
	// built-in view's persisted sort underneath.
	const activeSavedViewId = useStoreValue(
		documentTableViewStore,
		(view) => view.activeSavedViewId,
	);
	const savedSort = useStoreValue(savedViewsStore, (all) =>
		workspacePath && activeSavedViewId
			? all[workspacePath]?.views.find((view) => view.id === activeSavedViewId)
					?.sort
			: undefined,
	);
	const navSort = useNavViewSort(activeView);
	const sort = savedSort ?? navSort;
	const isNameSort = sort.column === "name" && sort.direction === "asc";
	const sortNext = isNameSort ? "recent" : "name";

	const toggleSortMode = () => {
		const next = isNameSort
			? DEFAULT_NAV_VIEW_SORT
			: ({ column: "name", direction: "asc" } as const);
		if (savedSort) setDocumentTableSort(next);
		else setNavViewSort(workspacePath, activeView, next);
	};

	const isRail = navTier === "rail";
	const showDots = isRail && entries.length > 1;
	const renamingName = renamingId ? savedName(renamingId) : "";

	return (
		<div
			data-nav-list-header
			data-variant={variant}
			className={cn(
				"flex shrink-0 items-center gap-1",
				isTabs ? "border-b border-mdly-line" : "justify-between",
			)}
		>
			{renamingId && renamingName ? (
				<SavedViewNameInput
					className="flex min-w-0 flex-1 flex-col"
					fill
					initialName={renamingName}
					onCommit={(name) => {
						const result = renameSavedView(renamingId, name);
						if (result.ok) setRenamingId(null);
						return result;
					}}
					onCancel={() => setRenamingId(null)}
				/>
			) : showDots ? (
				<NavViewDots
					entries={entries}
					active={activeKey}
					onSelect={selectEntry}
					onToggleHidden={toggleHidden}
					onSavedViewMenu={openSavedViewMenu}
					onWheel={onWheel}
				/>
			) : !isRail ? (
				<div
					data-nav-view-switcher
					className={cn(
						"flex min-w-0 items-center overflow-x-auto",
						isTabs ? "gap-0.5" : "gap-1",
					)}
					onWheel={onWheel}
				>
					{inlineEntries.map((entry) => {
						const isActive = activeKey === entry.key;
						const label = navEntryLabel(entry);
						const isHidden =
							entry.kind === "builtin" &&
							entry.view !== "recent" &&
							hidden.includes(entry.view);
						return (
							<button
								key={entry.key}
								type="button"
								data-nav-view-option={entry.key}
								aria-pressed={isActive}
								aria-label={`${label} view`}
								title={
									entry.kind === "saved"
										? `${label} — right-click to rename or delete`
										: entry.view === "recent"
											? "Recent view"
											: isHidden
												? `${label} view (hidden from Rail — select to restore)`
												: `${label} view — right-click to hide`
								}
								className={cn(
									isTabs
										? cn(
												"relative -mb-px flex h-8 min-w-0 shrink-0 items-center gap-1 border-b-2 px-2.5 text-[12px] outline-hidden transition-colors duration-150 ease-snappy focus-visible:ring-1 focus-visible:ring-mdly-ink motion-reduce:transition-none",
												entry.kind === "saved" && "max-w-44",
												isActive
													? "border-mdly-ink font-semibold text-mdly-strong"
													: "border-transparent text-muted-foreground hover:text-foreground",
												isHidden && !isActive && "opacity-50",
											)
										: "",
									!isTabs &&
										"flex h-7 min-w-0 items-center gap-1 rounded-[var(--radius-row)] text-start text-[length:var(--font-size-sidebar)] outline-hidden transition-[background-color,color] duration-150 ease-snappy [padding-inline:var(--row-pad-inline)] hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none",
									!isTabs && entry.kind === "saved" && "max-w-40",
									!isTabs &&
										(isActive
											? "bg-selected font-medium text-selected-foreground"
											: "text-muted-foreground hover:text-foreground"),
									!isTabs && isHidden && !isActive && "opacity-50",
								)}
								onClick={() =>
									entry.kind === "builtin"
										? selectInline(entry.view)
										: selectEntry(entry)
								}
								onContextMenu={(event) => {
									event.preventDefault();
									if (entry.kind === "saved") {
										openSavedViewMenu(entry.id, event.currentTarget);
									} else if (entry.view !== "recent") {
										toggleHidden(entry.view);
									}
								}}
							>
								<NavEntryIcon entry={entry} />
								<span className="min-w-0 truncate">{label}</span>
								{isTabs && isActive && hasUnsavedChanges ? (
									<span
										data-unsaved-dot
										role="img"
										aria-label="Unsaved changes"
										title="Unsaved changes"
										className="size-1.5 shrink-0 rounded-full bg-mdly-ink"
									/>
								) : null}
							</button>
						);
					})}
				</div>
			) : null}
			{isTabs ? (
				<>
					{trailing}
					<span aria-hidden="true" className="min-w-2 flex-1" />
					{end}
				</>
			) : null}
			<SavedViewContextMenu
				anchor={menu?.anchor ?? null}
				name={savedName(menu?.id ?? null)}
				onClose={() => setMenu(null)}
				onRename={() => {
					const id = menu?.id;
					setMenu(null);
					// Open the name box after the menu has closed and settled focus,
					// or the closing menu's focus move would blur (cancel) it.
					if (id) setTimeout(() => setRenamingId(id), 0);
				}}
				onDelete={() => {
					const undo = menu ? deleteSavedView(menu.id) : null;
					setMenu(null);
					// One toast id: a second delete replaces it (undo = latest only).
					if (undo) {
						toast("View deleted", {
							id: "saved-view-deleted",
							duration: 5000,
							action: {
								label: "Undo",
								onClick: () => {
									undo();
								},
							},
						});
					}
				}}
			/>
			<Button
				variant="ghost"
				size="icon-xs"
				aria-label="Sort documents"
				aria-pressed={isNameSort}
				title={`Sorted by ${describeNavViewSort(sort)} — select to sort by ${sortNext}`}
				onClick={toggleSortMode}
			>
				{isNameSort ? (
					<MingcuteAzSortAscendingLettersLine
						aria-hidden="true"
						className="size-3.5"
					/>
				) : (
					<MingcuteSortDescendingLine aria-hidden="true" className="size-3.5" />
				)}
			</Button>
		</div>
	);
}
