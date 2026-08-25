import { Dialog } from "@base-ui/react/dialog";
import type { ReactNode } from "react";
import MingcuteCloseLine from "~icons/mingcute/close-line";
import { usePortalContainer } from "../lib/portalContainer";
import { cn } from "../lib/utils";
import { Button } from "./button";

type Props = {
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	title: string;
	className?: string;
	children: ReactNode;
};

/**
 * Right-edge slide-in panel -- unlike `Modal`, this doesn't block the rest of
 * the document: `modal={false}` (base-ui) keeps the live editor/diff pane
 * fully interactive while the panel is open, and the backdrop is
 * pointer-events-none since it exists only to match Modal's structure, not
 * to intercept clicks (a plain `fixed inset-0` div blocks every click over
 * it regardless of the `modal` prop unless pointer events are explicitly
 * disabled on it). `disablePointerDismissal` is also required: base-ui
 * closes a dialog on ANY pointer press outside `Dialog.Popup` by default,
 * and the diff view's change-rail (rendered in the main pane, i.e. outside
 * the popup) is exactly such an "outside" click -- without this, clicking a
 * rail dash would instantly close the panel (and, per the desktop wiring,
 * clear the diff along with it) instead of scrolling to the change. This
 * panel now closes only via its own Close button or Escape. Anchored
 * full-height to the trailing edge with a translate-x enter/exit instead of
 * a centered scale/fade. Its content wrapper is a real flex container
 * (unlike `Modal`'s plain-block wrapper), so a child can use
 * `flex-1`/`min-h-0` for its own internal scroll region without that being
 * silently inert.
 */
function SidePanel({ open, onOpenChange, title, className, children }: Props) {
	const portalContainer = usePortalContainer();
	return (
		<Dialog.Root
			open={open}
			onOpenChange={onOpenChange}
			modal={false}
			disablePointerDismissal
		>
			<Dialog.Portal container={portalContainer}>
				<Dialog.Backdrop className="pointer-events-none fixed inset-0 z-40 bg-transparent" />
				<Dialog.Popup
					className={cn(
						"fixed inset-y-0 end-0 z-50 flex w-80 max-w-[calc(100vw-2rem)] translate-x-0 flex-col border-s border-border bg-popover p-4 text-popover-foreground opacity-100 shadow-overlay outline-hidden transition-[translate,opacity] duration-300 ease-snappy data-[ending-style]:translate-x-full data-[ending-style]:opacity-0 data-[starting-style]:translate-x-full data-[starting-style]:opacity-0",
						className,
					)}
				>
					<div className="mb-3 flex shrink-0 items-start justify-between gap-3">
						<Dialog.Title className="m-0 text-sm font-semibold">
							{title}
						</Dialog.Title>
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
					<div className="flex min-h-0 flex-1 flex-col">{children}</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

export { SidePanel };
