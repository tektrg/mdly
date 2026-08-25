import { groupChangeRegions } from "@mdly/doc-history";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../primitives/button";
import { DiffChangeRail } from "./DiffChangeRail";
import { DiffGroupsView } from "./DiffGroupsView";
import {
	CAUSE_LABELS,
	formatRevisionTime,
	type Revision,
} from "./RevisionList";

export type ReadRevisionContentResult =
	| { status: "ok"; content: string }
	| { status: "unavailable" }
	| { status: "not-found" };

type SelectionState =
	| { status: "loading" }
	| { status: "loaded"; content: string }
	| { status: "unavailable" }
	| { status: "not-found" }
	| { status: "error"; message: string };

export type RevisionDiffViewProps = {
	/** The revision being viewed -- the whole object, so the header can show
	 * its cause/time directly without a lookup back into the list. */
	revision: Revision;
	/** The note's current (live) content, diffed against `revision` (R10). */
	currentContent: string;
	/**
	 * Read-only fetch for the revision's stored content (R19 -- viewing never
	 * appends to the history log). Must resolve `{status:"unavailable"}` for
	 * an unreadable/evicted blob rather than throwing (R17); a rejected
	 * promise is also handled, surfaced as a distinct error state.
	 */
	onReadRevisionContent: (
		revisionId: string,
	) => Promise<ReadRevisionContentResult>;
	/** Leaves the diff view and returns to the live editor. */
	onBack: () => void;
};

/**
 * Full-pane, read-only diff of one revision against the note's current
 * content (R10, R17, R19) -- replaces the main document pane while a
 * revision is being viewed (see apps/desktop's `ReadyDocument`). Same region
 * renderer as `DiffReviewPanel`, no accept/reject controls, plus a
 * change-location rail (`DiffChangeRail`) mirroring the editor's heading TOC.
 */
export function RevisionDiffView({
	revision,
	currentContent,
	onReadRevisionContent,
	onBack,
}: RevisionDiffViewProps) {
	const [selection, setSelection] = useState<SelectionState>({
		status: "loading",
	});
	const containerRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		let active = true;
		setSelection({ status: "loading" });
		onReadRevisionContent(revision.id)
			.then((result) => {
				if (!active) return;
				if (result.status === "ok") {
					setSelection({ status: "loaded", content: result.content });
				} else {
					setSelection({ status: result.status });
				}
			})
			.catch((err: unknown) => {
				if (!active) return;
				setSelection({
					status: "error",
					message: err instanceof Error ? err.message : String(err),
				});
			});
		return () => {
			active = false;
		};
	}, [revision.id, onReadRevisionContent]);

	const groups = useMemo(
		() =>
			selection.status === "loaded"
				? groupChangeRegions(selection.content, currentContent)
				: [],
		[selection, currentContent],
	);

	return (
		// pe-80 reserves the width of the always-open history side panel
		// (SidePanel's `w-80`) -- this view only ever renders while that panel
		// is open (closing it clears the viewed revision, see apps/desktop's
		// `ReadyDocument`), and the panel is a fixed-position overlay that
		// doesn't shrink this pane's own layout box. Without this, both long
		// diff lines and the change rail below render underneath the panel's
		// opaque background instead of in the visible area beside it.
		<div className="flex h-full min-h-0 flex-col pe-80">
			{/* pt-11 (2.75rem) matches apps/desktop's invisible window-drag strip
			    height -- this header renders at the very top of the document pane,
			    the same dead zone that twice needed this exact fix for other
			    controls in that pane (see App.tsx / Toolbar.tsx history). Harmless
			    padding for consumers without a native drag strip. */}
			<div className="flex shrink-0 items-center justify-between gap-3 border-border border-b px-4 pt-11 pb-2">
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate font-medium text-sm">
						{CAUSE_LABELS[revision.cause] ?? revision.cause}
					</span>
					<span className="shrink-0 text-muted-foreground text-xs">
						{formatRevisionTime(revision.at)}
					</span>
				</div>
				<Button variant="outline" size="sm" onClick={onBack}>
					Back to editor
				</Button>
			</div>
			<div className="relative min-h-0 flex-1">
				<div
					ref={containerRef}
					data-revision-diff
					className="h-full overflow-y-auto p-4 pe-8"
				>
					<SelectionBody selection={selection} groups={groups} />
				</div>
				<DiffChangeRail groups={groups} containerRef={containerRef} />
			</div>
		</div>
	);
}

function SelectionBody({
	selection,
	groups,
}: {
	selection: SelectionState;
	groups: ReturnType<typeof groupChangeRegions>;
}) {
	if (selection.status === "loading") {
		return <p className="m-0 text-muted-foreground text-xs">Loading…</p>;
	}
	if (selection.status === "unavailable") {
		return (
			<p
				className="m-0 text-muted-foreground text-xs"
				data-revision-unavailable
			>
				This revision's content is unavailable.
			</p>
		);
	}
	if (selection.status === "not-found") {
		return (
			<p
				className="m-0 text-muted-foreground text-xs"
				data-revision-unavailable
			>
				This revision could not be found.
			</p>
		);
	}
	if (selection.status === "error") {
		return (
			<p className="m-0 text-destructive text-xs" data-revision-error>
				Failed to load this revision: {selection.message}
			</p>
		);
	}
	return (
		<DiffGroupsView
			groups={groups}
			emptyMessage="No changes since this revision."
		/>
	);
}
