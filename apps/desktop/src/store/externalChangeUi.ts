import { store } from "@simplestack/store";

/**
 * Non-persisted UI flag controlling the raw Markdown `ExternalChangeReviewDialog`.
 * Shared between `Toolbar` ("Review external change") and `SuggestionReviewBar`
 * ("Raw diff" fallback when reviewing inline external changes).
 */
export const externalChangeRawDialogOpenStore = store(false);
