import {
	type ChangeGroupDecisions,
	groupChangeRegions,
	mergeSelectedRegions,
} from "@mdly/doc-history";
import { useEffect, useMemo, useState } from "react";
import { Button } from "../primitives/button";
import { DiffGroupsView } from "./DiffGroupsView";

export type DiffReviewPanelProps = {
	/** The frozen pre-external-edit text (R3, R4's "pre-external-edit text"). */
	oldText: string;
	/** The incoming disk text the review is deciding what to do with. */
	newText: string;
	/**
	 * Called with the merged result of the user's current accept/reject picks
	 * (R6). A group with no explicit pick defaults to "accept" (R5), matching
	 * `mergeSelectedRegions`'s own default -- so confirming without touching
	 * anything reproduces `newText` exactly, same as the old silent-swap.
	 */
	onConfirm: (mergedText: string) => void;
	onCancel?: () => void;
};

/**
 * Region-by-region diff/review surface (R2-R6): breaks `oldText`/`newText`
 * into added/removed/unchanged regions via `@mdly/doc-history`'s
 * `groupChangeRegions`, lets the user accept or reject each changed region
 * individually, and hands back the exact merged text on confirm. Purely
 * presentational -- holds only the in-progress decision map; the caller owns
 * what happens to the confirmed text (writing it to disk, tagging a
 * revision, etc).
 */
export function DiffReviewPanel({
	oldText,
	newText,
	onConfirm,
	onCancel,
}: DiffReviewPanelProps) {
	const groups = useMemo(
		() => groupChangeRegions(oldText, newText),
		[oldText, newText],
	);
	const [decisions, setDecisions] = useState<ChangeGroupDecisions>({});
	// R11: if a second external edit lands while this review is still open,
	// the caller re-renders with a new `newText` reflecting the cumulative
	// change. Group ids are assigned by position (`group-0`, `group-1`, ...),
	// so a differently-shaped diff could otherwise reuse an old id for an
	// unrelated new region -- reset picks whenever the underlying diff changes
	// rather than risk a stale decision silently applying to the wrong region.
	// biome-ignore lint/correctness/useExhaustiveDependencies: oldText/newText are the reset signal, not read in the body.
	useEffect(() => {
		setDecisions({});
	}, [oldText, newText]);

	const changedGroups = groups.filter((group) => group.kind === "changed");

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<div
				className="min-h-0 flex-1 overflow-y-auto rounded-sm border border-border bg-background p-3"
				data-diff-review-body
			>
				<DiffGroupsView
					groups={groups}
					emptyMessage="No changes to review."
					renderControls={(group) => (
						<ReviewControls
							decision={decisions[group.id] ?? "accept"}
							onDecide={(decision) =>
								setDecisions((current) => ({
									...current,
									[group.id]: decision,
								}))
							}
						/>
					)}
				/>
			</div>
			{changedGroups.length > 0 && (
				<div className="flex shrink-0 items-center justify-between gap-3">
					<span className="text-muted-foreground text-xs">
						{changedGroups.length} changed{" "}
						{changedGroups.length === 1 ? "region" : "regions"}
					</span>
					<div className="flex items-center gap-2">
						{onCancel && (
							<Button variant="outline" size="sm" onClick={onCancel}>
								Cancel
							</Button>
						)}
						<Button
							size="sm"
							onClick={() => onConfirm(mergeSelectedRegions(groups, decisions))}
						>
							Apply
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

function ReviewControls({
	decision,
	onDecide,
}: {
	decision: "accept" | "reject";
	onDecide: (decision: "accept" | "reject") => void;
}) {
	return (
		<span className="ms-2 inline-flex items-center gap-1 align-middle font-sans">
			<Button
				type="button"
				variant={decision === "accept" ? "default" : "outline"}
				size="xs"
				aria-pressed={decision === "accept"}
				onClick={() => onDecide("accept")}
			>
				Accept
			</Button>
			<Button
				type="button"
				variant={decision === "reject" ? "default" : "outline"}
				size="xs"
				aria-pressed={decision === "reject"}
				onClick={() => onDecide("reject")}
			>
				Reject
			</Button>
		</span>
	);
}
