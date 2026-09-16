/**
 * R8: the table has to tell three situations apart — the workspace scan has not
 * finished, the scan failed, and the workspace genuinely holds no Markdown
 * documents. `refreshFiles` reports a failed listing as `files: []`, so without
 * this a deleted, unmounted or permission-revoked folder would render as a
 * confident "no documents".
 */
export type DocumentListingState =
	| { kind: "scanning" }
	| { kind: "failed"; message: string }
	| { kind: "listed" };

export function resolveDocumentListingState(workspace: {
	hasListedOnce: boolean;
	listingError: string | null;
}): DocumentListingState {
	if (workspace.listingError !== null) {
		return { kind: "failed", message: workspace.listingError };
	}
	if (!workspace.hasListedOnce) return { kind: "scanning" };
	return { kind: "listed" };
}
