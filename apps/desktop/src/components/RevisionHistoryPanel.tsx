import { RevisionList, SidePanel } from "@mdly/workspace-kit";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { desktopApi } from "../desktopApi";
import type { HistoryRevision } from "../desktopApi/types";

/**
 * Right-side revision-history panel (R8-R10, R16, R19): opens for whatever
 * note is currently open, independent of whether a review is pending.
 * Read-only -- never appends to the note's history log. Diffing a selected
 * revision happens elsewhere (see `RevisionDiffView`, rendered in the main
 * document pane by `App.tsx`'s `ReadyDocument`) -- this panel only owns the
 * list and reports the full `Revision` object for whichever row is clicked,
 * since the diff view needs more than just an id.
 */
export function RevisionHistoryPanel({
	open,
	onOpenChange,
	path,
	selectedRevisionId,
	onSelectRevision,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	path: string | null;
	selectedRevisionId: string | null;
	onSelectRevision: (revision: HistoryRevision) => void;
}) {
	const [revisions, setRevisions] = useState<HistoryRevision[]>([]);

	useEffect(() => {
		if (!open || !path) return;
		let active = true;
		setRevisions([]);
		desktopApi
			.getRevisionHistory(path)
			.then((history) => {
				if (!active) return;
				// getRevisionHistory returns oldest-first, in the log's true
				// prev-chain edit order (R9). Reversing is a structural flip, not a
				// re-sort by `at` -- the list still never re-derives order from
				// timestamps, so a clock-skewed/forked log can't scramble it.
				setRevisions([...history].reverse());
			})
			.catch((err: unknown) => {
				if (!active) return;
				toast.error("Failed to load revision history", {
					description: err instanceof Error ? err.message : String(err),
				});
			});
		return () => {
			active = false;
		};
	}, [open, path]);

	if (!path) return null;

	return (
		<SidePanel open={open} onOpenChange={onOpenChange} title="Revision history">
			<RevisionList
				revisions={revisions}
				selectedRevisionId={selectedRevisionId}
				onSelectRevision={(id) => {
					const revision = revisions.find((r) => r.id === id);
					if (revision) onSelectRevision(revision);
				}}
			/>
		</SidePanel>
	);
}
