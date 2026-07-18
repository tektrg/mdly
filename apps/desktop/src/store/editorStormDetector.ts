// Round-2 runtime detector for the background-OOM crash.
//
// The 3.37 GB heap snapshot proved the crash is a React update-queue explosion
// (~29.6M pending update objects) localized to the Markdown editor subtree:
// EditorView plus its overlays (VirtualCursor et al.). Dereferencing the pending
// updates showed VirtualCursor being pumped with setCursorMode("hidden") — i.e.
// the editor emits a *storm of transaction events while unfocused*, and every
// overlay setStates per event faster than React can commit. A heap snapshot
// records what piled up but NOT the JS stack driving the loop, and every editor
// dispatch site is statically input-gated, so the driver must be captured live.
//
// This subscribes to the editor's transaction stream and, when the rate crosses
// the storm threshold, records ONE report: the offending transaction's shape
// (empty vs doc-changing, which plugin metas it carries) and the synchronous
// dispatch stack — which names the driver. Reuses the throttled, kill-switch-
// respecting bridge in stormDetector.ts. Cost in normal use is one counter
// increment per transaction; the detail probe + stack run only on a storm.
//
// See memory note 202607160130-mdly-oom-react-update-queue-explosion.

import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { recordStormEvent } from "./stormDetector";

const EDITOR_TRANSACTION_STORM_LABEL = "editor.transaction";

export function observeEditorTransactionStorms(editor: Editor): () => void {
	const onTransaction = ({ transaction }: { transaction: Transaction }) => {
		recordStormEvent(EDITOR_TRANSACTION_STORM_LABEL, () =>
			describeStormTransaction(editor, transaction),
		);
	};
	editor.on("transaction", onTransaction);
	return () => {
		editor.off("transaction", onTransaction);
	};
}

// Captured only when a storm fires. `metaKeys` is the highest-signal field: a
// transaction carrying e.g. "linkCreationGhost$" or "fakeSelection$" names the
// plugin re-dispatching in a loop. An empty (steps: 0, docChanged: false)
// transaction storm points instead at a redundant selection/no-op dispatcher.
function describeStormTransaction(
	editor: Editor,
	transaction: Transaction,
): Record<string, unknown> {
	return {
		steps: transaction.steps.length,
		docChanged: transaction.docChanged,
		selectionSet: transaction.selectionSet,
		metaKeys: metaKeysOf(transaction),
		editorFocused: safeBool(() => editor.isFocused),
		documentHidden: typeof document === "undefined" ? null : document.hidden,
		visibilityState:
			typeof document === "undefined" ? null : document.visibilityState,
	};
}

function metaKeysOf(transaction: Transaction): string[] {
	// ProseMirror stores transaction metadata as a plain string-keyed object;
	// there is no public enumerator, so read the property directly.
	const meta = (transaction as unknown as { meta?: Record<string, unknown> })
		.meta;
	if (!meta || typeof meta !== "object") return [];
	return Object.keys(meta);
}

function safeBool(read: () => boolean): boolean | null {
	try {
		return read();
	} catch {
		return null;
	}
}
