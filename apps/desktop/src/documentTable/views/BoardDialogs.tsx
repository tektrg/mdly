import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Button } from "@hubble.md/ui";
import { usePortalContainer } from "@mdly/workspace-kit";
import { type FormEvent, useState } from "react";
import type { DocumentTableRow } from "../documentTableView";

export type BoardDialogState =
	| { kind: "rename"; row: DocumentTableRow; title: string }
	| { kind: "delete"; row: DocumentTableRow; title: string }
	| null;

/** Rename (file name) and Delete confirmation for a board card. */
export function BoardDialogs({
	state,
	onClose,
	onRename,
	onDelete,
}: {
	state: BoardDialogState;
	onClose: () => void;
	onRename: (row: DocumentTableRow, name: string) => void;
	onDelete: (row: DocumentTableRow) => void;
}) {
	const portalContainer = usePortalContainer();
	return (
		<AlertDialog.Root
			open={state !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<AlertDialog.Portal container={portalContainer}>
				<AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/20" />
				<AlertDialog.Popup className="fixed start-1/2 top-1/3 z-50 flex w-80 -translate-x-1/2 flex-col gap-3 rounded-[var(--radius-popover)] border border-border bg-popover p-4 text-sm text-popover-foreground shadow-overlay outline-hidden">
					{state?.kind === "rename" ? (
						<RenameForm
							key={state.row.path}
							row={state.row}
							onCancel={onClose}
							onSubmit={(name) => {
								onRename(state.row, name);
								onClose();
							}}
						/>
					) : state?.kind === "delete" ? (
						<>
							<AlertDialog.Title className="m-0 text-sm font-semibold">
								Delete “{state.title}”?
							</AlertDialog.Title>
							<AlertDialog.Description className="m-0 text-xs text-muted-foreground">
								The file {state.row.name}.md will be removed from disk.
							</AlertDialog.Description>
							<div className="flex justify-end gap-2">
								<Button size="sm" variant="ghost" onClick={onClose}>
									Cancel
								</Button>
								<Button
									size="sm"
									variant="destructive"
									onClick={() => {
										onDelete(state.row);
										onClose();
									}}
								>
									Delete
								</Button>
							</div>
						</>
					) : null}
				</AlertDialog.Popup>
			</AlertDialog.Portal>
		</AlertDialog.Root>
	);
}

function RenameForm({
	row,
	onCancel,
	onSubmit,
}: {
	row: DocumentTableRow;
	onCancel: () => void;
	onSubmit: (name: string) => void;
}) {
	const [name, setName] = useState(row.name);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		const trimmed = name.trim();
		if (trimmed.length > 0 && trimmed !== row.name) onSubmit(trimmed);
		else onCancel();
	};
	return (
		<form onSubmit={submit} className="flex flex-col gap-3">
			<AlertDialog.Title className="m-0 text-sm font-semibold">
				Rename file
			</AlertDialog.Title>
			<input
				// biome-ignore lint/a11y/noAutofocus: the dialog exists to type a name.
				autoFocus
				aria-label="File name"
				value={name}
				onChange={(event) => setName(event.target.value)}
				onFocus={(event) => event.target.select()}
				className="h-8 rounded-[var(--radius-row)] border border-border bg-background px-2 text-sm"
			/>
			<div className="flex justify-end gap-2">
				<Button type="button" size="sm" variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
				<Button type="submit" size="sm">
					Rename
				</Button>
			</div>
		</form>
	);
}
