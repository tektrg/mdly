import type { Transaction } from "@tiptap/pm/state";

/**
 * `EditorView` only autosaves when the user interacted inside
 * `USER_EDIT_INTENT_WINDOW_MS` — a deliberate guard, refreshed on key-down and
 * pointer-down, that exists because three renderer-overload incidents traced
 * back to unattended edits flushing to disk.
 *
 * A pointer gesture that *commits* on release (a table handle drag, a dot-menu
 * Delete) can easily outlast that window, so the change would land on screen
 * and silently never reach the file. Ruling R-H / charter R12: do not widen the
 * window and do not add a global mouse-up refresher — instead the committing
 * transaction says, at the exact moment it commits, "this is a user edit".
 *
 * Every table command routes through `tableTransformTransaction`, which stamps
 * its transaction here, so this stays the single narrow re-marking path.
 */
const USER_EDIT_INTENT_META = "mdlyUserEditIntent";

/** Stamp a committing transaction as a deliberate user edit (R12). */
export function markTransactionAsUserEdit<T extends Transaction>(
	transaction: T,
): T {
	transaction.setMeta(USER_EDIT_INTENT_META, true);
	return transaction;
}

/** True when this transaction re-marks user edit intent (R12). */
export function transactionCarriesUserEditIntent(
	transaction: Transaction,
): boolean {
	return transaction.getMeta(USER_EDIT_INTENT_META) === true;
}
