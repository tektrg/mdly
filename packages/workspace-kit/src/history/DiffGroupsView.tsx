import type { ChangeGroup } from "@mdly/doc-history";
import type { ReactNode } from "react";

/**
 * Shared read-only region renderer for `DiffReviewPanel` and
 * `RevisionTimeline` (R2): each `unchanged` group renders as plain text; each
 * `changed` group expands into up to two tagged spans -- `removed` (the old
 * text) and `added` (the incoming text) -- so a caller can query
 * `[data-region-type]` and see exactly which kind of region is on screen,
 * never one opaque "changed" blob. `renderControls` is the only difference
 * between the interactive (DiffReviewPanel) and read-only (RevisionTimeline)
 * callers -- everything else, including the exact DOM shape the tests assert
 * on, is identical between them by construction.
 */
export function DiffGroupsView({
	groups,
	renderControls,
	emptyMessage,
}: {
	groups: ChangeGroup[];
	renderControls?: (
		group: Extract<ChangeGroup, { kind: "changed" }>,
	) => ReactNode;
	emptyMessage?: string;
}) {
	if (groups.length === 0) {
		return emptyMessage ? (
			<p className="m-0 font-sans text-muted-foreground text-xs">
				{emptyMessage}
			</p>
		) : null;
	}

	return (
		<div
			className="whitespace-pre-wrap font-mono text-[12px] leading-5"
			data-diff-groups
		>
			{groups.map((group) =>
				group.kind === "unchanged" ? (
					<span key={group.id} data-region-type="unchanged">
						{group.value}
					</span>
				) : (
					<span
						key={group.id}
						data-region-id={group.id}
						className="inline-block w-full align-top"
					>
						{group.oldText.length > 0 && (
							<span
								data-region-type="removed"
								className="bg-diff-removed text-diff-removed-foreground line-through decoration-diff-removed-foreground/40"
							>
								{group.oldText}
							</span>
						)}
						{group.newText.length > 0 && (
							<span
								data-region-type="added"
								className="bg-diff-added text-diff-added-foreground"
							>
								{group.newText}
							</span>
						)}
						{renderControls?.(group)}
					</span>
				),
			)}
		</div>
	);
}
