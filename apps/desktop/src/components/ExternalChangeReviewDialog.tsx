import { Modal } from "@hubble.md/ui";
import { DiffReviewPanel } from "@mdly/workspace-kit";

/**
 * Modal wrapper around the kit's region-by-region diff/review surface
 * (R2-R6), following the same Modal-wrapping-a-kit-panel pattern already used
 * for `FilePropertiesPanel`. `oldText` is the frozen pre-external-edit
 * baseline (`state.diskContent` while a review is pending); `newText` is the
 * pending external change (`externalChange.diskContent`).
 */
export function ExternalChangeReviewDialog({
	open,
	onOpenChange,
	oldText,
	newText,
	onConfirm,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	oldText: string;
	newText: string;
	/** Resolves to whether the merge actually landed on disk (see
	 * `resolveExternalChangeReview`). The dialog only closes on `true` — on
	 * `false` (write failure, stale disk, unsaved local edits) it stays open
	 * with the user's picks intact so they can see the error and retry. */
	onConfirm: (mergedText: string) => Promise<boolean>;
}) {
	if (!open) return null;

	return (
		<Modal
			open={open}
			onOpenChange={onOpenChange}
			title="Review external changes"
			description="This note changed outside the app. Accept or reject each change, then apply."
			className="flex h-[70vh] max-w-2xl flex-col"
		>
			<DiffReviewPanel
				oldText={oldText}
				newText={newText}
				onCancel={() => onOpenChange(false)}
				onConfirm={(mergedText) => {
					void (async () => {
						const applied = await onConfirm(mergedText);
						if (applied) onOpenChange(false);
					})();
				}}
			/>
		</Modal>
	);
}
