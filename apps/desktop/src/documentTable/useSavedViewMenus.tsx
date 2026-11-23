import { useState } from "react";
import { toast } from "sonner";
import {
	deleteSavedView,
	renameSavedView,
	setSavedViewIcon,
} from "./documentTableStore";
import { navEntryLabel } from "./NavViewIcon";
import type { NavSwitcherEntry } from "./navSwitcherEntries";
import { SavedViewContextMenu } from "./SavedViewControls";
import { SavedViewIconPicker } from "./SavedViewIconPicker";

/**
 * Saved views R2, shared by every view switcher (the list header and the left
 * view bar): the right-click menu of a saved view (rename / change icon /
 * delete with undo), its icon picker, and which view is being renamed. The
 * caller places the rename box (`renaming`) where it fits and renders `menus`
 * once.
 */
export function useSavedViewMenus(entries: readonly NavSwitcherEntry[]) {
	// The right-clicked saved icon (menu anchor) and the one being renamed.
	const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(
		null,
	);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [iconPicker, setIconPicker] = useState<{
		id: string;
		anchor: HTMLElement;
	} | null>(null);
	const savedEntry = (id: string | null | undefined) =>
		entries.find(
			(candidate) => candidate.kind === "saved" && candidate.id === id,
		);
	const savedName = (id: string | null | undefined) => {
		const entry = savedEntry(id);
		return entry ? navEntryLabel(entry) : "";
	};
	const pickerEntry = savedEntry(iconPicker?.id);

	const openSavedViewMenu = (id: string, anchor: HTMLElement) =>
		setMenu({ id, anchor });

	const renamingName = renamingId ? savedName(renamingId) : "";
	/** The view being renamed, while it still exists; null otherwise. */
	const renaming =
		renamingId && renamingName
			? {
					id: renamingId,
					name: renamingName,
					commit: (name: string) => {
						const result = renameSavedView(renamingId, name);
						if (result.ok) setRenamingId(null);
						return result;
					},
					cancel: () => setRenamingId(null),
				}
			: null;

	const menus = (
		<>
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
				onChangeIcon={() => {
					const current = menu;
					setMenu(null);
					// After the menu closes, or its focus return would steal the search box.
					if (current) setTimeout(() => setIconPicker(current), 0);
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
			<SavedViewIconPicker
				anchor={pickerEntry ? (iconPicker?.anchor ?? null) : null}
				name={pickerEntry ? navEntryLabel(pickerEntry) : ""}
				current={pickerEntry?.kind === "saved" ? pickerEntry.icon : undefined}
				onClose={() => setIconPicker(null)}
				onSelect={(icon) => {
					if (iconPicker) setSavedViewIcon(iconPicker.id, icon);
					setIconPicker(null);
				}}
			/>
		</>
	);

	return { openSavedViewMenu, renaming, menus };
}
