/**
 * Slice 2 — session-only full-width state for in-document tables
 * (charter R19–R25, rulings R-I as amended by R-N, R-O).
 *
 * Full width is a look, never a fact about the file: expanding a table flips
 * a CSS class on its own `.tableWrapper` scroll box and records the table's
 * session id in the in-memory set below. Nothing is written to the document —
 * no transaction is ever dispatched from this module — so the Markdown file,
 * its timestamp, the revision history and `git status` all stay untouched
 * (R23), and reopening the document parses fresh ids that start collapsed.
 *
 * Width itself is pure CSS (`TableWidthControl.module.css`, `100cqi` units
 * against the editor pane established as a query container). It re-fits live
 * when panels open/close, the window resizes or the user zooms, with no
 * scroll/resize listeners anywhere (R20, R36/R-M).
 */

/** Minimal editor surface this module needs: just the event emitter. */
export type NudgeEditor = {
	emit(event: string, payload?: unknown): void;
};

/** Session-only set of expanded table uids (charter R23). */
const expandedTableUids = new Set<string>();

export function isTableExpanded(uid: string): boolean {
	return expandedTableUids.has(uid);
}

export function setTableExpanded(uid: string, expanded: boolean): void {
	// Deleting on collapse (rather than storing `false`) keeps the set exactly
	// the expanded tables, so entries for closed documents never accumulate.
	if (expanded) expandedTableUids.add(uid);
	else expandedTableUids.delete(uid);
}

/**
 * Feature-local overlay re-measure nudge (charter R25 / ruling R-O): expanding
 * or collapsing moves every block below the table on screen without changing
 * the document, so the comment markers and the caret overlay would sit at
 * stale positions until the next scroll or keystroke. This emits exactly one
 * synthetic `transaction` event so those two overlays re-read layout —
 * deliberately NOT a *new* shared editor-wide layout signal (R-O forbids
 * editing the components that also run in the web apps to add one), and
 * deliberately NOT a real dispatch (a real transaction with `docChanged:
 * false` is skipped by both overlays' R34 guards, and a real document change
 * would dirty the file).
 *
 * Known, accepted trade-off: this is Tiptap's single generic event bus, so
 * the fake `docChanged: true` reaches every `"transaction"` listener in the
 * app, not just the two this nudge targets — there is no narrower channel
 * without editing one of those shared, cross-app files, which R-O rules out.
 * Most listeners are cheap re-reads (headings, find/replace matches, the
 * status bar). The one with a real cost is `useCommentThreads`'s anchor
 * resolver, which re-serializes the whole document to Markdown — but only
 * when the document already has at least one comment thread (its own empty
 * fast path skips subscribing entirely otherwise), and only once per click,
 * never a compounding loop. `steps: []` and `selectionSet: false` keep the
 * desktop storm-detail reader (which only runs past 100 events/second — one
 * click never storms) on a real-looking shape.
 */
export function nudgeTableOverlays(editor: NudgeEditor): void {
	editor.emit("transaction", {
		transaction: { docChanged: true, steps: [], selectionSet: false },
	});
}

type PaneHold = {
	count: number;
	/** The pane's previous inline `container-type`, if we overwrote one. */
	previous: string | null;
	/** Whether this hold installed the value (false when already present). */
	applied: boolean;
};

const paneHolds = new Map<HTMLElement, PaneHold>();

/**
 * Establish the editor pane (the `.editorViewport` scroll container) as a
 * query container so `100cqi` in the width stylesheet measures the pane's own
 * live width — never the window (R-N: a window-sized table slides under the
 * comment panel and sidebar). Reference-counted across tables sharing one
 * pane; the last release restores whatever inline value was there before.
 * Purely a runtime DOM style — no editor or app file is touched.
 */
export function acquirePaneContainer(pane: HTMLElement): () => void {
	let hold = paneHolds.get(pane);
	if (!hold) {
		hold = { count: 0, previous: null, applied: false };
		paneHolds.set(pane, hold);
	}
	hold.count += 1;
	if (
		!hold.applied &&
		pane.style.getPropertyValue("container-type") !== "inline-size"
	) {
		hold.previous = pane.style.getPropertyValue("container-type") || null;
		hold.applied = true;
		pane.style.setProperty("container-type", "inline-size");
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const current = paneHolds.get(pane);
		if (!current) return;
		current.count -= 1;
		if (current.count > 0) return;
		paneHolds.delete(pane);
		if (!current.applied) return;
		if (current.previous)
			pane.style.setProperty("container-type", current.previous);
		else pane.style.removeProperty("container-type");
	};
}
