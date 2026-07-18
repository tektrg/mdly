// The editor defers markdown serialization off the keystroke path, so
// viewerStore.content can lag the on-screen text by up to the save debounce.
// Any action that reads viewerStore.content as the live editor draft must call
// flushEditorDraft() first to commit pending edits synchronously.

type EditorDraftFlush = () => void;

let activeEditorDraftFlush: EditorDraftFlush | null = null;

/** Registers the mounted editor's flush hook; returns an unregister callback. */
export function registerEditorDraftFlush(flush: EditorDraftFlush) {
	activeEditorDraftFlush = flush;
	return () => {
		if (activeEditorDraftFlush === flush) activeEditorDraftFlush = null;
	};
}

/** Synchronously commits any pending editor edits into viewerStore.content. */
export function flushEditorDraft() {
	activeEditorDraftFlush?.();
}
