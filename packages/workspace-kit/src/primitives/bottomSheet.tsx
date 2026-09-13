import { Dialog } from "@base-ui/react/dialog";
import { type ReactNode, useEffect, useState } from "react";
import MingcuteCloseLine from "~icons/mingcute/close-line";
import { usePortalContainer } from "../lib/portalContainer";
import { useKeyboardOffset } from "../lib/useKeyboardOffset";
import { cn } from "../lib/utils";
import { Button } from "./button";

type Props = {
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	title: string;
	description?: string;
	className?: string;
	children: ReactNode;
};

/**
 * Bottom-anchored sheet for narrow viewports — the mobile counterpart to
 * `SidePanel` (right edge) and `Modal` (centered). Same base-ui Dialog
 * foundation as both: `modal={false}` keeps the document interactive behind
 * the sheet, while a backdrop tap, the Close button, or Escape dismisses it.
 *
 * Half-height by default with a drag-handle toggle to near-full (`data-snap`
 * drives the max-height so tests can assert it). The sheet lifts above the
 * soft keyboard via `useKeyboardOffset` (visualViewport) plus safe-area
 * padding, so inputs docked at its bottom stay visible. The content wrapper
 * is a real flex column (like SidePanel's), so children can use
 * `flex-1`/`min-h-0` internal scroll regions.
 */
function BottomSheet({
	open,
	onOpenChange,
	title,
	description,
	className,
	children,
}: Props) {
	const portalContainer = usePortalContainer();
	const [expanded, setExpanded] = useState(false);
	const keyboardOffset = useKeyboardOffset(open ?? false);
	useEffect(() => {
		if (open) setExpanded(false);
	}, [open]);
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange} modal={false}>
			<Dialog.Portal container={portalContainer}>
				<Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 opacity-100 transition-opacity duration-200 ease-snappy data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
				<Dialog.Popup
					data-snap={expanded ? "full" : "half"}
					className={cn(
						"fixed inset-inline-0 bottom-0 z-50 flex flex-col rounded-t-[var(--radius-popover)] border-t border-border bg-popover text-popover-foreground shadow-overlay outline-hidden transition-[translate,opacity] duration-300 ease-snappy data-[ending-style]:translate-y-full data-[ending-style]:opacity-0 data-[starting-style]:translate-y-full data-[starting-style]:opacity-0",
						className,
					)}
					style={{
						bottom: keyboardOffset,
						maxBlockSize: expanded ? "90dvh" : "55dvh",
					}}
				>
					<button
						type="button"
						className="flex shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent pb-1 pt-2.5"
						aria-label={expanded ? "Collapse panel" : "Expand panel"}
						aria-expanded={expanded}
						onClick={() => setExpanded((value) => !value)}
					>
						<span
							aria-hidden="true"
							className="block h-1 w-10 rounded-full bg-border"
						/>
					</button>
					<div className="flex min-h-0 shrink-0 items-start justify-between gap-3 px-4">
						<div className="flex min-w-0 flex-col gap-1">
							<Dialog.Title className="m-0 text-sm font-semibold">
								{title}
							</Dialog.Title>
							{description && (
								<Dialog.Description className="m-0 text-xs text-muted-foreground">
									{description}
								</Dialog.Description>
							)}
						</div>
						<Dialog.Close
							render={
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Close"
									type="button"
								>
									<MingcuteCloseLine />
								</Button>
							}
						/>
					</div>
					<div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-3">
						{children}
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

export { BottomSheet };
