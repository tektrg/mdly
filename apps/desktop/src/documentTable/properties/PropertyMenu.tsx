import { Menu } from "@base-ui/react/menu";
import { usePortalContainer } from "@mdly/workspace-kit";
import type { ReactNode } from "react";
import MingcuteCheckLine from "~icons/mingcute/check-line";
import { cn } from "../../lib/utils";

const MENU_POPUP_CLASS =
	"max-h-80 w-60 origin-(--transform-origin) overflow-y-auto rounded-[18px] bg-popover p-1 text-[11px] text-popover-foreground shadow-overlay outline-hidden transition-[transform,opacity] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

/** What an anchored menu opens against: an element, or a point (right-click). */
export type MenuAnchor =
	| Element
	| { getBoundingClientRect: () => DOMRect; contextElement?: Element };

/** A zero-size anchor at the pointer, for a menu opened by right-click. */
export function pointerAnchor(
	clientX: number,
	clientY: number,
	contextElement?: Element,
): MenuAnchor {
	return {
		getBoundingClientRect: () =>
			DOMRect.fromRect({ x: clientX, y: clientY, width: 0, height: 0 }),
		...(contextElement ? { contextElement } : {}),
	};
}

/**
 * `PropertyMenu`'s popup with no trigger of its own: one instance serves a
 * whole list (e.g. every board card), opened against whichever element or
 * point the caller passes, so N rows don't each mount a menu.
 */
export function AnchoredPropertyMenu({
	anchor,
	open,
	onClose,
	returnFocus,
	label,
	children,
	align = "end",
}: {
	anchor: MenuAnchor | null;
	open: boolean;
	onClose: () => void;
	/** Focused after the menu closes (the trigger a dropdown would refocus). */
	returnFocus?: HTMLElement | null;
	label: string;
	children: ReactNode;
	align?: "start" | "end";
}) {
	const portalContainer = usePortalContainer();
	return (
		<Menu.Root
			open={open && anchor !== null}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<Menu.Portal container={portalContainer}>
				<Menu.Positioner
					className="z-50"
					anchor={anchor}
					align={align}
					side="bottom"
					sideOffset={4}
				>
					<Menu.Popup
						aria-label={label}
						finalFocus={() => (returnFocus?.isConnected ? returnFocus : true)}
						className={MENU_POPUP_CLASS}
					>
						{children}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

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
	open,
	onOpenChange,
}: {
	trigger: ReactNode;
	triggerClassName: string;
	triggerLabel: string;
	children: ReactNode;
	align?: "start" | "end";
	/** Controlled open state (e.g. a card's right-click opens its menu). */
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	const portalContainer = usePortalContainer();
	return (
		<Menu.Root
			{...(open !== undefined ? { open } : {})}
			{...(onOpenChange ? { onOpenChange: (next) => onOpenChange(next) } : {})}
		>
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
					<Menu.Popup className={MENU_POPUP_CLASS}>{children}</Menu.Popup>
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
				"flex h-7 cursor-pointer items-center gap-2 rounded-mdly-control px-2 outline-hidden data-highlighted:bg-accent",
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
	return <Menu.Separator className="my-1 h-px bg-transparent" />;
}

const POPUP_CLASS =
	"max-h-80 w-52 origin-(--transform-origin) overflow-y-auto rounded-[18px] bg-popover p-1 text-[11px] text-popover-foreground shadow-overlay outline-hidden";

/** A nested "Label ▸" menu inside a `PropertyMenu`. */
export function PropertySubmenu({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	const portalContainer = usePortalContainer();
	return (
		<Menu.SubmenuRoot>
			<Menu.SubmenuTrigger className="flex h-7 cursor-pointer items-center gap-2 rounded-mdly-control px-2 outline-hidden data-highlighted:bg-accent data-popup-open:bg-accent">
				<span className="min-w-0 flex-1 truncate">{label}</span>
				<span aria-hidden="true" className="text-muted-foreground/70">
					▸
				</span>
			</Menu.SubmenuTrigger>
			<Menu.Portal container={portalContainer}>
				<Menu.Positioner className="z-50" sideOffset={2}>
					<Menu.Popup className={POPUP_CLASS}>{children}</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.SubmenuRoot>
	);
}
