import { Menu } from "@base-ui/react/menu";
import { usePortalContainer } from "@mdly/workspace-kit";
import type { ReactNode } from "react";
import MingcuteCheckLine from "~icons/mingcute/check-line";
import { cn } from "../../lib/utils";

/**
 * The property surfaces' one dropdown: the kit's `ActionsMenu` look (same
 * popup classes) with a caller-supplied trigger and a scrollable body, since a
 * workspace can carry dozens of properties.
 */
export function PropertyMenu({
	trigger,
	triggerClassName,
	triggerLabel,
	children,
	align = "end",
}: {
	trigger: ReactNode;
	triggerClassName: string;
	triggerLabel: string;
	children: ReactNode;
	align?: "start" | "end";
}) {
	const portalContainer = usePortalContainer();
	return (
		<Menu.Root>
			<Menu.Trigger
				render={
					<button
						type="button"
						className={triggerClassName}
						aria-label={triggerLabel}
						title={triggerLabel}
					/>
				}
			>
				{trigger}
			</Menu.Trigger>
			<Menu.Portal container={portalContainer}>
				<Menu.Positioner
					className="z-50"
					align={align}
					side="bottom"
					sideOffset={4}
				>
					<Menu.Popup className="max-h-80 w-60 origin-(--transform-origin) overflow-y-auto rounded-[var(--radius-popover)] border border-border bg-popover p-1 text-[11px] text-popover-foreground shadow-overlay outline-hidden transition-[transform,opacity] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
						{children}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

export function PropertyMenuItem({
	children,
	onClick,
	checked,
	hint,
	disabled,
}: {
	children: ReactNode;
	onClick: () => void;
	/** Renders a check column; omit for plain action items. */
	checked?: boolean;
	/** Faded right-hand detail, e.g. a document count. */
	hint?: string;
	disabled?: boolean;
}) {
	return (
		<Menu.Item
			disabled={disabled}
			className={cn(
				"flex h-7 cursor-pointer items-center gap-2 rounded-sm px-2 outline-hidden data-highlighted:bg-accent",
				disabled && "cursor-default opacity-50",
			)}
			onClick={onClick}
		>
			{checked !== undefined ? (
				<span className="inline-flex size-3.5 shrink-0 items-center justify-center">
					{checked ? <MingcuteCheckLine aria-hidden="true" /> : null}
				</span>
			) : null}
			<span className="min-w-0 flex-1 truncate">{children}</span>
			{hint ? (
				<span className="shrink-0 tabular-nums text-muted-foreground/70">
					{hint}
				</span>
			) : null}
		</Menu.Item>
	);
}

export function PropertyMenuLabel({ children }: { children: ReactNode }) {
	return (
		<div className="px-2 pt-1.5 pb-1 text-[10px] uppercase text-muted-foreground/70">
			{children}
		</div>
	);
}

export function PropertyMenuSeparator() {
	return <Menu.Separator className="my-1 h-px bg-border" />;
}
