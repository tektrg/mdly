// Locally-declared, structurally identical to `@mdly/doc-history`'s
// `Revision`/`RevisionAuthor`/`RevisionCause` -- mirrors the same convention
// `apps/desktop/src/desktopApi/types.ts` already uses for its IPC contract,
// so a host wires this component up from data it already has (e.g.
// `desktopApi.getRevisionHistory`'s result) without needing to import
// `@mdly/doc-history` itself just for its public prop types.
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

export const CAUSE_LABELS: Record<RevisionCause, string> = {
	"external-write": "Edited outside the app",
	"idle-session": "Autosaved",
	manual: "You reviewed and merged this",
	import: "Imported",
	restore: "Restored from history",
};

export function formatRevisionTime(at: number) {
	try {
		return new Date(at).toLocaleString();
	} catch {
		return "";
	}
}

export type RevisionListProps = {
	/**
	 * Rendered in exactly the given array order (R9) -- never re-sorted by
	 * `at`. The caller decides ordering (mdly's own IPC returns oldest-first
	 * and reverses before handing revisions to this component for its
	 * newest-first display, R8); this component never re-derives order from
	 * timestamps, so a clock-skewed or forked log can't scramble it.
	 */
	revisions: Revision[];
	/** The revision whose diff is currently being viewed, if any. */
	selectedRevisionId: string | null;
	onSelectRevision: (revisionId: string) => void;
};

/**
 * Revision list (R8, R9, R16): renders revisions newest-first (as given)
 * with a plain-English cause label. Selection lives with the caller -- this
 * component only reports clicks, it doesn't own or fetch diff content
 * (that now renders in a different part of the layout, see
 * `RevisionDiffView`).
 */
export function RevisionList({
	revisions,
	selectedRevisionId,
	onSelectRevision,
}: RevisionListProps) {
	if (revisions.length === 0) {
		return (
			<p className="m-0 text-muted-foreground text-sm" data-timeline-empty>
				No history yet.
			</p>
		);
	}

	return (
		<ul
			className="m-0 flex min-h-0 flex-1 list-none flex-col gap-0.5 overflow-y-auto p-0"
			data-revision-list
		>
			{revisions.map((revision) => (
				<li key={revision.id}>
					<button
						type="button"
						data-revision-row
						data-revision-id={revision.id}
						aria-pressed={selectedRevisionId === revision.id}
						className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-start text-[12px] outline-hidden hover:bg-accent aria-pressed:bg-selected"
						onClick={() => onSelectRevision(revision.id)}
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
	);
}
