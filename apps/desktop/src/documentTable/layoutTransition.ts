import { flushSync } from "react-dom";

/**
 * Animated switch between the full-width document table and the peek split
 * (narrow list + document pane), in both directions.
 *
 * Uses the View Transitions API: the browser snapshots the old layout, we
 * commit the new one synchronously inside the callback, and the compositor
 * cross-fades/clips the two snapshots (CSS in `index.css`, names `doc-list`
 * and `doc-pane`). Nothing re-renders per frame, so a 50k-row virtualized list
 * costs one commit, not one per animation frame.
 *
 * The selected row keeps its on-screen offset across the switch: its offset
 * inside the old list's scroller is captured here, and the newly mounted
 * `DocumentRowList` consumes it (`takeScrollAnchor`) in a layout effect —
 * inside the same `flushSync`, so the new snapshot already shows it in place.
 */

type ScrollAnchor = { path: string; offset: number };

let pendingAnchor: ScrollAnchor | null = null;

/** Viewport offset of the row for `path` inside its scrolling rowgroup. */
export function measureRowAnchor(
	path: string,
	root: ParentNode = document,
): ScrollAnchor | null {
	const row = root.querySelector<HTMLElement>(
		`[data-document-path="${CSS.escape(path)}"]`,
	);
	const scroller = row?.closest<HTMLElement>('[role="rowgroup"]');
	if (!row || !scroller) return null;
	const offset =
		row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
	return { path, offset };
}

/** One-shot read of the anchor a layout switch left behind, if any. */
export function takeScrollAnchor(): ScrollAnchor | null {
	const anchor = pendingAnchor;
	pendingAnchor = null;
	return anchor;
}

/**
 * scrollTop that puts row `index` at `offset` px below the scroller's top,
 * clamped to the scrollable range — the row always ends up fully visible.
 */
export function anchoredScrollTop({
	index,
	rowHeight,
	offset,
	clientHeight,
	contentHeight,
}: {
	index: number;
	rowHeight: number;
	offset: number;
	clientHeight: number;
	contentHeight: number;
}): number {
	const visibleOffset = Math.min(
		Math.max(offset, 0),
		Math.max(clientHeight - rowHeight, 0),
	);
	const maxScroll = Math.max(contentHeight - clientHeight, 0);
	return Math.min(Math.max(index * rowHeight - visibleOffset, 0), maxScroll);
}

function prefersReducedMotion(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

type ViewTransitionDocument = Omit<Document, "startViewTransition"> & {
	startViewTransition?: (update: () => void) => {
		updateCallbackDone: Promise<void>;
	};
};

/**
 * Runs `update` (a store write that flips the layout) inside a view
 * transition. Falls back to a plain synchronous call when motion is reduced
 * or the API is missing (tests, older engines). Resolves once `update` ran.
 *
 * Rapid re-entry is safe: starting a new transition skips the running one
 * (the browser jumps it to its end state), and each `update` is a plain store
 * write, so the last one wins.
 */
export function runLayoutTransition(
	update: () => void,
	anchorPath: string | null = null,
): Promise<void> {
	// Node-environment store tests have no DOM at all.
	const doc =
		typeof document === "undefined"
			? null
			: (document as ViewTransitionDocument);
	pendingAnchor = doc && anchorPath ? measureRowAnchor(anchorPath, doc) : null;
	if (
		!doc ||
		prefersReducedMotion() ||
		typeof doc.startViewTransition !== "function"
	) {
		update();
		return Promise.resolve();
	}
	const transition = doc.startViewTransition(() => {
		flushSync(update);
	});
	return transition.updateCallbackDone.catch(() => {});
}
