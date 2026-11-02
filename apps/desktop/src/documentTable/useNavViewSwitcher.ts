import { useSidebarSwipeNav } from "@mdly/workspace-kit";
import { useStoreValue } from "@simplestack/store/react";
import { type WheelEvent as ReactWheelEvent, useCallback, useRef } from "react";
import { workspacePathStore, workspaceStore } from "../store/state";
import {
	documentTableViewStore,
	selectBuiltInView,
	selectSavedView,
} from "./documentTableStore";
import { savedViewsStore } from "./documentViewsFileStore";
import {
	groupByToViewId,
	NAV_VIEW_IDS,
	type NavViewId,
	type NavViewOption,
	setNavHiddenViewToggled,
} from "./navHiddenViews";
import {
	builtInEntries,
	type NavSwitcherEntry,
	type NavSwitcherKey,
	savedEntries,
	savedViewKey,
} from "./navSwitcherEntries";
import type { SavedDocumentView } from "./properties/documentViews";

/** Stable empty for the hidden-views selector (see below). */
const NO_HIDDEN_VIEWS: NavViewOption[] = [];
const NO_SAVED_VIEWS: SavedDocumentView[] = [];

/**
 * The one place that knows which nav views exist, which are visible, which is
 * active, and how to move between them — shared by the header's switcher (inline
 * buttons / Rail dots) and the swipe region over the list, so neither keeps its
 * own copy of that logic.
 */
export function useNavViewSwitcher() {
	// The built-in the list is grouped by (sort, hide fallback): a saved view
	// shows with no nav grouping, so it reads as "recent" here.
	const activeView = useStoreValue(documentTableViewStore, (view) =>
		groupByToViewId(view.groupBy),
	);
	const activeSavedId = useStoreValue(
		documentTableViewStore,
		(view) => view.activeSavedViewId,
	);
	const workspacePath = useStoreValue(workspacePathStore) ?? null;
	const savedViews = useStoreValue(savedViewsStore, (all) =>
		workspacePath
			? (all[workspacePath]?.views ?? NO_SAVED_VIEWS)
			: NO_SAVED_VIEWS,
	);
	// The fallback is a module constant, not a literal: the selector must
	// return a stable reference or the external-store snapshot never settles.
	const hidden = useStoreValue(workspaceStore, (workspace) =>
		workspacePath
			? (workspace.navHiddenViews[workspacePath] ?? NO_HIDDEN_VIEWS)
			: NO_HIDDEN_VIEWS,
	) as readonly NavViewOption[];
	// `recent` is never in `hidden`, so it is always visible.
	const visible = NAV_VIEW_IDS.filter(
		(view) => view === "recent" || !hidden.includes(view),
	);
	const saved = savedEntries(savedViews);
	/** Dots and swipe: visible built-ins, then saved views (R1). */
	const entries: NavSwitcherEntry[] = [...builtInEntries(visible), ...saved];
	/** Inline buttons: every built-in (hidden ones dimmed), then saved views. */
	const inlineEntries: NavSwitcherEntry[] = [
		...builtInEntries(NAV_VIEW_IDS),
		...saved,
	];
	// Only a loaded saved view counts as active; during the brief first paint
	// before the file is read, no icon is pressed (the selection is kept).
	const activeKey: NavSwitcherKey | null = activeSavedId
		? savedViews.some((view) => view.id === activeSavedId)
			? savedViewKey(activeSavedId)
			: null
		: activeView;

	const select = (view: NavViewId) => {
		if (view === activeKey) return;
		selectBuiltInView(view);
	};

	const selectEntry = (entry: NavSwitcherEntry) => {
		if (entry.kind === "builtin") select(entry.view);
		else if (entry.key !== activeKey) selectSavedView(entry.id);
	};

	const toggleHidden = (view: NavViewOption) => {
		const next = setNavHiddenViewToggled(workspacePath, view);
		// Hiding the active view falls back to recent, so the list can never sit
		// on a hidden view. Anything else stays put.
		if (next?.includes(view) && view === activeView) select("recent");
	};

	// A hidden view is restored by selecting it at a wider tier — the Rail
	// strip has no room for a restore target of its own.
	const selectInline = (view: NavViewId) => {
		if (view !== "recent" && hidden.includes(view)) {
			setNavHiddenViewToggled(workspacePath, view);
		}
		select(view);
	};

	const { onWheel } = useSidebarSwipeNav({
		activePage: Math.max(
			0,
			entries.findIndex((entry) => entry.key === activeKey),
		),
		pageCount: entries.length,
		onPageChange: (page) => {
			// First paint (remembered saved view not loaded yet): paging from a
			// guessed page 0 would replace the remembered view (R3).
			if (activeKey === null) return;
			const entry = entries[page];
			if (entry !== undefined) selectEntry(entry);
		},
	});

	// React attaches `wheel` as a passive listener, so `preventDefault` in
	// `onWheel` is ignored. A scrollable list would then scroll sideways AND flip
	// the view; a native non-passive listener lets the swipe claim the gesture.
	// The handler is read through a ref so the listener is attached once per
	// element, not re-attached on every render.
	const onWheelRef = useRef(onWheel);
	onWheelRef.current = onWheel;
	const detachSwipeRef = useRef<(() => void) | null>(null);
	const swipeRef = useCallback((element: HTMLElement | null) => {
		detachSwipeRef.current?.();
		detachSwipeRef.current = null;
		if (!element) return;
		// The handler only reads deltaX/deltaY and calls preventDefault, which
		// native and React wheel events share.
		const handler = (event: WheelEvent) => {
			// A list widened past its container scrolls sideways with the same
			// gesture; the swipe only claims lists with nothing to scroll.
			if (element.scrollWidth > element.clientWidth) return;
			onWheelRef.current(event as unknown as ReactWheelEvent<HTMLElement>);
		};
		element.addEventListener("wheel", handler, { passive: false });
		detachSwipeRef.current = () =>
			element.removeEventListener("wheel", handler);
	}, []);

	return {
		activeView,
		activeKey,
		hidden,
		visible,
		entries,
		inlineEntries,
		select,
		selectEntry,
		selectInline,
		toggleHidden,
		onWheel,
		swipeRef,
	};
}
