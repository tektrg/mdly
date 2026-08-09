import { type RefObject, useCallback, useEffect, useState } from "react";
import { isEditableEventTarget } from "../lib/dom";

export const EDITOR_INPUT_SELECTOR = "[data-editor-input]";

/** Stable identity so the default doesn't re-create `onKeyDown` every render. */
const NO_EDITABLE_KEYS: readonly string[] = [];

export function useSidebarKeyboardNav<T>({
	items,
	onSelect,
	onEnter,
	onExpand,
	onCollapse,
	navRef,
	activeIndex = -1,
	editableKeys = NO_EDITABLE_KEYS,
}: {
	items: T[];
	onSelect: (item: T) => void;
	onEnter?: (item: T) => void;
	onExpand?: (item: T) => void;
	onCollapse?: (item: T) => void;
	navRef: RefObject<HTMLElement | null>;
	activeIndex?: number;
	/**
	 * Keys this list handles even when the keystroke came from a text input.
	 *
	 * Only the Search page sets it: its query box *is* the list's focus target,
	 * so arrows and Enter there are navigation rather than typing. Everything
	 * else -- notably the tree's inline rename box, which sits inside the same
	 * `onKeyDown` container -- keeps the blanket bail-out below, or renaming a
	 * file would move the selection instead of the caret.
	 *
	 * Space and the horizontal arrows should never be listed here: inside an
	 * input those insert a character or move the caret, and stealing them makes
	 * the box unusable.
	 */
	editableKeys?: readonly string[];
}) {
	const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
	const getActionIndex = useCallback(
		() => focusedIndex ?? (activeIndex >= 0 ? activeIndex : null),
		[activeIndex, focusedIndex],
	);

	useEffect(() => {
		if (focusedIndex === null) return;
		navRef.current
			?.querySelector(`[data-sidebar-index="${focusedIndex}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [focusedIndex, navRef]);

	const onKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			if (items.length === 0) return;
			if (
				isEditableEventTarget(event.target) &&
				!editableKeys.includes(event.key)
			)
				return;

			switch (event.key) {
				case "ArrowDown":
				case "ArrowUp": {
					event.preventDefault();
					const delta = event.key === "ArrowDown" ? 1 : -1;
					setFocusedIndex((prev) => {
						const start = prev ?? (activeIndex >= 0 ? activeIndex : -1);
						return Math.max(0, Math.min(start + delta, items.length - 1));
					});
					break;
				}
				case "Enter": {
					const idx = getActionIndex();
					if (idx !== null && items[idx]) {
						event.preventDefault();
						(onEnter ?? onSelect)(items[idx]);
					}
					break;
				}
				case " ": {
					const idx = getActionIndex();
					if (idx !== null && items[idx]) {
						event.preventDefault();
						onSelect(items[idx]);
					}
					break;
				}
				case "ArrowRight": {
					const idx = getActionIndex();
					if (idx !== null && items[idx] && onExpand) {
						event.preventDefault();
						onExpand(items[idx]);
					}
					break;
				}
				case "ArrowLeft": {
					const idx = getActionIndex();
					if (idx !== null && items[idx] && onCollapse) {
						event.preventDefault();
						onCollapse(items[idx]);
					}
					break;
				}
				case "Escape": {
					event.preventDefault();
					setFocusedIndex(null);
					document.querySelector<HTMLElement>(EDITOR_INPUT_SELECTOR)?.focus();
					break;
				}
			}
		},
		[
			items,
			onEnter,
			onSelect,
			onExpand,
			onCollapse,
			activeIndex,
			getActionIndex,
			editableKeys,
		],
	);

	return { focusedIndex, setFocusedIndex, onKeyDown };
}
