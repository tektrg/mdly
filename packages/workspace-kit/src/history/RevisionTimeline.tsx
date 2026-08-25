import { groupChangeRegions } from "@mdly/doc-history";
import { useState } from "react";
import { DiffGroupsView } from "./DiffGroupsView";

// Locally-declared, structurally identical to `@mdly/doc-history`'s
// `Revision`/`RevisionAuthor`/`RevisionCause`/`ReadRevisionContentResult` --
// mirrors the same convention `apps/desktop/src/desktopApi/types.ts` already
// uses for its IPC contract, so a host wires this component up from data it
// already has (e.g. `desktopApi.getRevisionHistory`'s result) without needing
// to import `@mdly/doc-history` itself just for its public prop types.
export type RevisionAuthorKind = "human" | "agent" | "external";

export type RevisionAuthor = {
	kind: RevisionAuthorKind;
	id: string;
	label?: string;
};

export type RevisionCause =
	| "external-write"
	| "idle-session"
	| "manual"
	| "import"
	| "restore";

export type Revision = {
	id: string;
	hash: string;
	at: number;
	by: RevisionAuthor;
	cause: RevisionCause;
	bytes: number;
	prev: string | null;
};

export type ReadRevisionContentResult =
	| { status: "ok"; content: string }
	| { status: "unavailable" }
	| { status: "not-found" };

const CAUSE_LABELS: Record<RevisionCause, string> = {
	"external-write": "Edited outside the app",
	"idle-session": "Autosaved",
	manual: "You reviewed and merged this",
	import: "Imported",
	restore: "Restored from history",
};

type SelectionState =
	| { status: "loading"; revisionId: string }
	| { status: "loaded"; revisionId: string; content: string }
	| { status: "unavailable"; revisionId: string }
	| { status: "not-found"; revisionId: string }
	| { status: "error"; revisionId: string; message: string };

export type RevisionTimelineProps = {
	/**
	 * Rendered in exactly the given array order (R9) -- never re-sorted by
	 * `at`. The caller decides ordering (mdly's own IPC returns oldest-first
	 * and reverses before handing revisions to this component for its
	 * newest-first display, R8); this component never re-derives order from
	 * timestamps, so a clock-skewed or forked log can't scramble it.
	 */
	revisions: Revision[];
	/** The note's current (live) content, diffed against a selected revision (R10). */
	currentContent: string;
	/**
	 * Read-only fetch for one revision's stored content (R19 -- viewing never
	 * appends to the history log). Must resolve `{status:"unavailable"}` for
	 * an unreadable/evicted blob rather than throwing (R17); a rejected
	 * promise is also handled, surfaced as a distinct error state.
	 */
	onReadRevisionContent: (
		revisionId: string,
	) => Promise<ReadRevisionContentResult>;
};

/**
 * Revision history browser (R8-R10, R16, R17, R19): lists revisions
 * newest-first with a plain-English cause label, and diffs a selected
 * revision against the note's current content using the same region renderer
 * as `DiffReviewPanel` (read-only here -- no accept/reject controls).
 */
export function RevisionTimeline({
	revisions,
	currentContent,
	onReadRevisionContent,
}: RevisionTimelineProps) {
	const [selection, setSelection] = useState<SelectionState | null>(null);

	if (revisions.length === 0) {
		return (
			<p className="m-0 text-muted-foreground text-sm" data-timeline-empty>
				No history yet.
			</p>
		);
	}

	const selectRevision = async (revisionId: string) => {
		setSelection({ status: "loading", revisionId });
		try {
			const result = await onReadRevisionContent(revisionId);
			if (result.status === "ok") {
				setSelection({ status: "loaded", revisionId, content: result.content });
			} else {
				setSelection({ status: result.status, revisionId });
			}
		} catch (err) {
			setSelection({
				status: "error",
				revisionId,
				message: err instanceof Error ? err.message : String(err),
			});
		}
	};

	return (
		// h-full (not flex-1): this component's host (RevisionHistoryDialog's
		// Modal) sizes its content slot via flexbox, but that slot itself is a
		// plain block element, so a `flex-1` here has no flex container to size
		// against and is silently ignored -- h-full resolves against the slot's
		// definite flex-computed height instead. Capping the list below (rather
		// than leaving it to grow with revision count) is what guarantees the
		// diff pane always keeps its own visible space: a long list pushing the
		// diff below one shared scroll region, with no scrollbar visible until
		// touched, is exactly how a selected revision's diff went missing (R10).
		<div className="flex h-full min-h-0 flex-col gap-3">
			<ul
				className="m-0 flex max-h-56 list-none flex-col gap-0.5 overflow-y-auto p-0"
				data-revision-list
			>
				{revisions.map((revision) => (
					<li key={revision.id}>
						<button
							type="button"
							data-revision-row
							data-revision-id={revision.id}
							aria-pressed={selection?.revisionId === revision.id}
							className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-start text-[12px] outline-hidden hover:bg-accent aria-pressed:bg-selected"
							onClick={() => void selectRevision(revision.id)}
						>
							<span className="min-w-0 flex-1 truncate">
								{CAUSE_LABELS[revision.cause] ?? revision.cause}
							</span>
							<span className="shrink-0 text-muted-foreground">
								{formatRevisionTime(revision.at)}
							</span>
						</button>
					</li>
				))}
			</ul>
			{selection && (
				<div
					className="min-h-0 flex-1 overflow-y-auto rounded-sm border border-border bg-background p-3"
					data-revision-diff
				>
					<SelectionBody
						selection={selection}
						currentContent={currentContent}
					/>
				</div>
			)}
		</div>
	);
}

function SelectionBody({
	selection,
	currentContent,
}: {
	selection: SelectionState;
	currentContent: string;
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
	const groups = groupChangeRegions(selection.content, currentContent);
	return (
		<DiffGroupsView
			groups={groups}
			emptyMessage="No changes since this revision."
		/>
	);
}

function formatRevisionTime(at: number) {
	try {
		return new Date(at).toLocaleString();
	} catch {
		return "";
	}
}
