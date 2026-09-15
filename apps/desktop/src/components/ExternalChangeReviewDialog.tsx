import { Button, Modal } from "@hubble.md/ui";
import { groupChangeRegions } from "@mdly/doc-history";
import { DiffGroupsView } from "@mdly/workspace-kit";
import { useMemo } from "react";

/**
 * Read-only view of an already-applied external change (R: content/diskContent
 * are never frozen -- the editor shows `currentContent` live regardless of
 * whether this dialog is open). `onUndo` reverts to `previousContent`; closing
 * without undoing leaves the applied change in place and the title-bar pill
 * up, same as before this dialog existed.
 */
export function ExternalChangeReviewDialog({
	open,
	onOpenChange,
	previousContent,
	currentContent,
	onUndo,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	previousContent: string;
	currentContent: string;
	onUndo: () => void;
}) {
	const groups = useMemo(
		() => groupChangeRegions(previousContent, currentContent),
		[previousContent, currentContent],
	);

	if (!open) return null;

	return (
		<Modal
			open={open}
			onOpenChange={onOpenChange}
			title="Review external change"
			description="This note changed outside the app. The change is already applied -- undo to restore what was here before."
			className="flex h-[70vh] max-w-2xl flex-col"
		>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<DiffGroupsView groups={groups} emptyMessage="No changes to show." />
			</div>
			<div className="mt-3 flex shrink-0 justify-end gap-2">
				<Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
					Keep it
				</Button>
				<Button
					variant="default"
					size="sm"
					onClick={() => {
						onUndo();
						onOpenChange(false);
					}}
				>
					Undo
				</Button>
			</div>
		</Modal>
	);
}
