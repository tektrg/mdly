import { Button, Modal } from "@hubble.md/ui";
import type { DocReimportResolution } from "../fileActions";

export function ReimportDocDialog({
	open,
	onOpenChange,
	onResolve,
	error,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onResolve: (resolution: DocReimportResolution) => void;
	error: string | null;
}) {
	if (!open) return null;

	return (
		<Modal
			open={open}
			onOpenChange={onOpenChange}
			title="Re-import document"
			className="max-w-md"
		>
			<div className="flex flex-col gap-4">
				<p className="m-0 text-sm text-muted-foreground">
					This document was imported from a source that may have changed.
					Re-importing is lossy and one-way, so it never overwrites your edits
					without asking. Choose what to do with the freshly converted version.
				</p>

				{error ? (
					<p className="m-0 text-sm text-destructive">{error}</p>
				) : null}

				<div className="flex flex-col gap-2">
					<Button size="sm" onClick={() => onResolve("replace")}>
						Replace from source
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={() => onResolve("keep-both")}
					>
						Keep both (new file)
					</Button>
					<Button
						size="sm"
						variant="ghost"
						onClick={() => onResolve("keep-local")}
					>
						Keep local
					</Button>
				</div>
			</div>
		</Modal>
	);
}