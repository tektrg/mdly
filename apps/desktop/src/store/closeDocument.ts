import { toast } from "sonner";
import { basename } from "../lib/filePath";
import { clearViewer, flushOutgoingEdits, loadPath } from "./actions";
import { recordDocNavigation, TABLE_NAV_ENTRY } from "./docNavigationHistory";
import { viewerStore } from "./state";

/**
 * Resets the document-scoped panels App owns (revision history, comments, and
 * the revision currently being diffed).
 *
 * Those three flags live in `App.tsx` state but are only reset inside
 * `ReadyDocument`'s `currentPath` effect. Closing a document *unmounts*
 * `ReadyDocument`, so that effect never runs and the flags stay true — the next
 * document would then open with a stale panel. The bug is latent today only
 * because nothing could close a document while staying in the app.
 *
 * Same registration seam as `editorDraft.ts`: the component that owns the state
 * registers a reset while it is mounted, and the store calls it without importing
 * React. Slice 3 wires `App.tsx` to this.
 */
type DocumentPanelReset = () => void;

let activeDocumentPanelReset: DocumentPanelReset | null = null;

/** Registers the mounted App's panel reset; returns an unregister callback. */
export function registerDocumentPanelReset(reset: DocumentPanelReset) {
	activeDocumentPanelReset = reset;
	return () => {
		if (activeDocumentPanelReset === reset) activeDocumentPanelReset = null;
	};
}

/**
 * Focus hand-off for a close. Nothing moved focus when the document went away,
 * so it fell back to `<body>` and the next Tab restarted from the top of the
 * window — a keyboard user had to tab through the whole chrome to reach the
 * table they had just been dropped into.
 *
 * Same registration seam as `registerDocumentPanelReset`: whichever surface
 * takes over the main panel registers how it claims focus while it is mounted,
 * and the store calls it without importing React or knowing that surface exists.
 */
type DocumentCloseFocus = () => void;

let activeDocumentCloseFocus: DocumentCloseFocus | null = null;

/**
 * Registers how the surface that takes over after a close claims focus; returns
 * an unregister callback.
 */
export function registerDocumentCloseFocus(takeFocus: DocumentCloseFocus) {
	activeDocumentCloseFocus = takeFocus;
	return () => {
		if (activeDocumentCloseFocus === takeFocus) activeDocumentCloseFocus = null;
	};
}

/** The viewer's document slice, as the store hands it out. */
type ViewerDocument = ReturnType<typeof viewerStore.get>;

/** A document is on the main panel even while its open is still in flight. */
function isShowingDocument(document: ViewerDocument): boolean {
	return document.currentPath !== null || document.requestedPath !== null;
}

function hasUnsavedEdits(document: ViewerDocument): boolean {
	return (
		document.currentPath !== null &&
		document.status === "ready" &&
		document.content !== document.diskContent
	);
}

/**
 * Says out loud what this close is throwing away when mdly auto-applied an
 * external change to the open file.
 *
 * `clearViewer()` resets `externalChange` to "none", and reopening the file does
 * not bring it back — so without this, one Escape silently destroyed the only
 * route back to the user's pre-external-change text.
 *
 * Two different losses hide behind the same state, told apart by whether the
 * document still had unsaved edits when the close started
 * (`documentBeforeClose`):
 *
 * - Edits were pending: the close's own flush ran `savePathContent`, whose
 *   preflight re-read the file, found it changed underneath, auto-applied the
 *   disk copy and returned *without writing*. The user's typing exists only as
 *   the Undo payload this close is about to destroy, so the message has to say
 *   the edits were discarded — calling that "an Undo" describes the wrong loss.
 * - No edits were pending: nothing the user typed is at stake, only the route
 *   back to the pre-external-change text.
 *
 * Why a notice rather than saving the edits or carrying the Undo across a
 * close/reopen: writing them would silently clobber the concurrent external
 * write that the conflict path exists to protect, and holding them needs a keyed
 * cache with staleness and eviction rules (a single slot is overwritten by the
 * next close — open A, close, open B, close, and A is gone again, silently).
 * That is machinery in exchange for a rarely-walked path. Telling the user is
 * stateless, and it holds on every close door — Escape, "All documents", Cmd+],
 * and a workspace switch.
 */
function warnIfCloseDiscardsText(documentBeforeClose: ViewerDocument) {
	const document = viewerStore.get();
	if (!document.currentPath || document.externalChange.kind !== "applied") {
		return;
	}
	const name = basename(document.currentPath);
	if (hasUnsavedEdits(documentBeforeClose)) {
		toast.warning("Your unsaved edits were discarded", {
			description: `${name} changed on disk while you were editing it, so mdly kept the disk copy and never saved your edits. Closing the document discards them for good.`,
		});
		return;
	}
	toast.warning("Undo for the external change is no longer available", {
		description: `${name} was reloaded from disk while it was open. Closing the document discards that Undo.`,
	});
}

export type CloseDocumentOptions = {
	/**
	 * Push `TABLE_NAV_ENTRY` onto the navigation stack. `false` when the close is
	 * itself the result of a back/forward step that already moved `current` onto
	 * the sentinel.
	 */
	recordNavigation?: boolean;
};

/**
 * Returns the main panel to the full-width document table (R7).
 *
 * This is the single door for "the viewer stops showing the current document",
 * whatever replaces it — Escape, "All documents", Cmd+], a back/forward step
 * onto the table entry, and a workspace switch (R1) all land here, so the
 * save-and-cancel guarantees below cannot be forgotten at one of them.
 *
 * The order matters:
 * 1. `loadPath.cancel()` first, so an open that is still in flight cannot land
 *    seconds later and re-open the document the user just closed.
 * 2. `flushOutgoingEdits()` saves the last (up to 500ms) of typing. Closing has
 *    never existed before, so nothing else flushes the autosave debounce here —
 *    the editor's unmount save races on a real close, and on a workspace switch
 *    it loses outright (it fires after `currentPath` is already null, so
 *    `savePathContent`'s path guard drops the write).
 * 3. Warn if this close discards the user's text — see
 *    `warnIfCloseDiscardsText`. Read *after* the flush, because the flush's own
 *    preflight can be what auto-applies a disk change, but compared against the
 *    snapshot taken *before* it, which is the only record of whether edits were
 *    still unsaved when the close started.
 * 4. Record the table as a navigation entry so Cmd+[ returns to the document.
 * 5. `clearViewer()` nulls `requestedPath` (and `currentPath`) via `emptyDoc`,
 *    which is what actually swaps the layout back to the table.
 * 6. Reset the App-owned panel flags — see `registerDocumentPanelReset`.
 * 7. Hand focus to whatever took over — see `registerDocumentCloseFocus`. Last,
 *    so the surface it focuses is already rendering the cleared state, and only
 *    when a document was actually on screen: `openWorkspace` leaves through this
 *    same door, so an unconditional hand-off yanked focus onto a document row
 *    when the user switched workspaces from the table with nothing open.
 */
export async function closeDocumentToTable(options?: CloseDocumentOptions) {
	loadPath.cancel();
	const documentBeforeClose = viewerStore.get();
	await flushOutgoingEdits();
	warnIfCloseDiscardsText(documentBeforeClose);
	if (options?.recordNavigation !== false) {
		recordDocNavigation(TABLE_NAV_ENTRY);
	}
	clearViewer();
	activeDocumentPanelReset?.();
	if (isShowingDocument(documentBeforeClose)) activeDocumentCloseFocus?.();
}
