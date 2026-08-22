import { Modal } from "@hubble.md/ui";
import { RevisionTimeline } from "@mdly/workspace-kit";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { desktopApi } from "../desktopApi";
import type { HistoryRevision } from "../desktopApi/types";

/**
 * Standalone revision-timeline entry point (R8-R10, R16, R19): opens for
 * whatever note is currently open, independent of whether a review is
 * pending. Read-only -- never appends to the note's history log.
 */
export function RevisionHistoryDialog({
	open,
	onOpenChange,
	path,
	currentContent,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	path: string | null;
	currentContent: string;
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
				// re-sort by `at` -- the timeline still never re-derives order from
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

	if (!open || !path) return null;

	return (
		<Modal
			open={open}
			onOpenChange={onOpenChange}
			title="Revision history"
			className="flex h-[70vh] max-w-2xl flex-col"
		>
			<RevisionTimeline
				revisions={revisions}
				currentContent={currentContent}
				onReadRevisionContent={(revisionId) =>
					desktopApi.readRevisionContent(path, revisionId)
				}
			/>
		</Modal>
	);
}
