import { Menu } from "@base-ui/react/menu";
import { usePortalContainer } from "@mdly/workspace-kit";
import type { ViewNameError, ViewNameResult } from "@tektrg/table-core";
import { useState } from "react";
import { MAX_SAVED_VIEW_NAME_LENGTH } from "./properties/documentViews";

const NAME_ERROR: Record<ViewNameError, string> = {
	empty: "Name can't be empty",
	too_long: `Name is longer than ${MAX_SAVED_VIEW_NAME_LENGTH} characters`,
	duplicate: "A view with this name already exists",
	builtin: "That name is taken by a built-in view",
};

/**
 * Inline name box for "Save view…" and "Rename" (saved views R2). Enter
 * commits through `onCommit`; a refused name keeps the box open with the
 * reason shown. Escape or blur cancels.
 */
export function SavedViewNameInput({
	initialName,
	onCommit,
	onCancel,
	className,
}: {
	initialName: string;
	onCommit: (name: string) => ViewNameResult;
	onCancel: () => void;
	className?: string;
}) {
	const [name, setName] = useState(initialName);
	const [error, setError] = useState<string | null>(null);
	return (
		<span className={className ?? "inline-flex min-w-0 flex-col"}>
			<input
				// biome-ignore lint/a11y/noAutofocus: opened by an explicit click, the user is about to type
				autoFocus
				aria-label="View name"
				aria-invalid={error !== null}
				value={name}
				maxLength={MAX_SAVED_VIEW_NAME_LENGTH}
				placeholder="View name"
				onChange={(event) => {
					setName(event.target.value);
					setError(null);
				}}
				onBlur={onCancel}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						const result = onCommit(name);
						if (!result.ok) setError(NAME_ERROR[result.reason]);
					} else if (event.key === "Escape") {
						event.preventDefault();
						onCancel();
					}
				}}
				className="h-7 w-40 min-w-0 rounded-md border border-input bg-background px-2 text-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring aria-invalid:border-destructive"
			/>
			{error ? (
				<span role="alert" className="text-[11px] text-destructive">
					{error}
				</span>
			) : null}
		</span>
	);
}

/**
 * Right-click menu of a saved-view icon: Rename / Delete. Built-ins never
 * get one (saved views R4).
 */
export function SavedViewContextMenu({
	anchor,
	name,
	onClose,
	onRename,
	onDelete,
}: {
	anchor: HTMLElement | null;
	name: string;
	onClose: () => void;
	onRename: () => void;
	onDelete: () => void;
}) {
	const portalContainer = usePortalContainer();
	return (
		<Menu.Root
			open={anchor !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<Menu.Portal container={portalContainer}>
				<Menu.Positioner
					className="z-50"
					anchor={anchor}
					align="start"
					side="bottom"
					sideOffset={4}
				>
					<Menu.Popup
						// Rename swaps the row for a name box that takes focus;
						// handing focus back to the icon would blur (cancel) it.
						finalFocus={false}
						aria-label={`${name} options`}
						className="w-44 origin-(--transform-origin) rounded-[var(--radius-popover)] border border-border bg-popover p-1 text-[11px] text-popover-foreground shadow-overlay outline-hidden"
					>
						<Menu.Item
							className="flex h-7 cursor-pointer items-center rounded-sm px-2 outline-hidden data-highlighted:bg-accent"
							onClick={onRename}
						>
							Rename view
						</Menu.Item>
						<Menu.Item
							className="flex h-7 cursor-pointer items-center rounded-sm px-2 text-destructive outline-hidden data-highlighted:bg-accent"
							onClick={onDelete}
						>
							Delete view
						</Menu.Item>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
