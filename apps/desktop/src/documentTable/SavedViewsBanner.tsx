import { useStoreValue } from "@simplestack/store/react";
import { workspacePathStore } from "../store/state";
import {
	dismissSavedViewsNotice,
	resetCorruptSavedViews,
	type SavedViewsNotice,
} from "./documentViewsFileStore";
import { useWorkspaceSavedViewsState } from "./useDocumentTableRows";

export function savedViewsNoticeText(notice: SavedViewsNotice): string {
	switch (notice.kind) {
		case "corrupt":
			return "Saved views file (.hubble/views.json) can't be read, so only the built-in views are shown. The file was left untouched.";
		case "unreadable":
			return `Saved views file (.hubble/views.json) can't be opened (${notice.error}). Only the built-in views are shown.`;
		case "skipped":
			return `Some saved views couldn't be loaded and were skipped (${notice.warnings.length}). They are kept in the file.`;
		case "write-error":
			return `Saved views couldn't be saved (${notice.error}). Your change is kept until you close this workspace.`;
		case "conflict":
			if (notice.lost.length > 0) {
				const what = notice.lost.join(", ");
				const verb = notice.lost.length === 1 ? "wasn't" : "weren't";
				return `${what.charAt(0).toUpperCase()}${what.slice(1)} ${verb} saved — the file changed elsewhere (another window or Mac). The newer views are shown.`;
			}
			return "Saved views changed elsewhere (another window or Mac), so your last change was not saved. The newer views are shown.";
	}
}

/**
 * Visible notice for the saved-views file (R18, R19, R21). Minimal on
 * purpose: the icon row (slice C) owns the rest of the saved-view UI.
 */
export function SavedViewsBanner() {
	const workspacePath = useStoreValue(workspacePathStore);
	const state = useWorkspaceSavedViewsState();
	const notice = state?.notice;
	if (!workspacePath || !notice) return null;
	return (
		<div
			role="alert"
			className="mx-3 my-1 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs"
			data-testid="saved-views-banner"
			data-notice={notice.kind}
		>
			<span className="min-w-0 flex-1">{savedViewsNoticeText(notice)}</span>
			{notice.kind === "corrupt" ? (
				<button
					type="button"
					className="shrink-0 underline"
					onClick={() => void resetCorruptSavedViews(workspacePath)}
				>
					Back up and start fresh
				</button>
			) : null}
			{notice.kind !== "corrupt" && notice.kind !== "unreadable" ? (
				<button
					type="button"
					className="shrink-0 underline"
					onClick={() => dismissSavedViewsNotice(workspacePath)}
				>
					Dismiss
				</button>
			) : null}
		</div>
	);
}
