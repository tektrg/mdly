import { Popover } from "@base-ui/react/popover";
import { usePortalContainer } from "@mdly/workspace-kit";
import { useId, useState } from "react";
import { cn } from "../lib/utils";
import { SavedViewIconGlyph } from "./SavedViewIconGlyph";
import {
	DEFAULT_SAVED_VIEW_ICON,
	filterSavedViewIcons,
	resolveSavedViewIcon,
} from "./savedViewIcons";

const COLUMNS = 8;

/**
 * Popover grid of the curated saved-view icons with a search box. Focus stays
 * in the search box; arrows move the highlight, Enter picks it, Escape closes.
 * `onSelect(null)` = "Reset to default".
 */
export function SavedViewIconPicker({
	anchor,
	name,
	current,
	onSelect,
	onClose,
}: {
	anchor: HTMLElement | null;
	name: string;
	current: string | undefined;
	onSelect: (icon: string | null) => void;
	onClose: () => void;
}) {
	const portalContainer = usePortalContainer();
	return (
		<Popover.Root
			open={anchor !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<Popover.Portal container={portalContainer}>
				<Popover.Positioner
					className="z-50"
					anchor={anchor}
					align="start"
					side="bottom"
					sideOffset={4}
				>
					<Popover.Popup
						aria-label={`Icon for ${name}`}
						className="w-[18rem] origin-(--transform-origin) rounded-[18px] bg-popover p-2 text-[11px] text-popover-foreground shadow-overlay outline-hidden"
					>
						<IconGrid current={current} onSelect={onSelect} />
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}

/** The picker body; exported for tests. */
export function IconGrid({
	current,
	onSelect,
}: {
	current: string | undefined;
	onSelect: (icon: string | null) => void;
}) {
	const [query, setQuery] = useState("");
	const icons = filterSavedViewIcons(query);
	const selected = resolveSavedViewIcon(current);
	const [active, setActive] = useState(() =>
		Math.max(
			0,
			icons.findIndex((icon) => icon.name === selected),
		),
	);
	const idBase = useId();
	const clamped = Math.min(active, Math.max(0, icons.length - 1));
	const activeIcon = icons[clamped];

	const move = (delta: number) => {
		if (icons.length === 0) return;
		setActive(Math.min(icons.length - 1, Math.max(0, clamped + delta)));
	};

	return (
		<div className="flex flex-col gap-2">
			<input
				// biome-ignore lint/a11y/noAutofocus: the picker was just opened to choose
				autoFocus
				type="search"
				aria-label="Search icons"
				placeholder="Search icons"
				value={query}
				role="combobox"
				aria-expanded="true"
				aria-controls={`${idBase}-grid`}
				aria-activedescendant={
					activeIcon ? `${idBase}-${activeIcon.name}` : undefined
				}
				onChange={(event) => {
					setQuery(event.target.value);
					setActive(0);
				}}
				onKeyDown={(event) => {
					const step: Record<string, number> = {
						ArrowRight: 1,
						ArrowLeft: -1,
						ArrowDown: COLUMNS,
						ArrowUp: -COLUMNS,
					};
					if (event.key in step) {
						event.preventDefault();
						move(step[event.key] as number);
					} else if (event.key === "Enter") {
						event.preventDefault();
						if (activeIcon) onSelect(activeIcon.name);
					}
				}}
				className="h-7 w-full min-w-0 rounded-full bg-mdly-control px-3 text-sm text-foreground outline-hidden placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-mdly-ink/20"
			/>
			<div
				id={`${idBase}-grid`}
				role="listbox"
				aria-label="Icons"
				className="grid max-h-56 grid-cols-8 gap-0.5 overflow-y-auto"
			>
				{icons.map((icon, index) => (
					<button
						key={icon.name}
						id={`${idBase}-${icon.name}`}
						type="button"
						role="option"
						tabIndex={-1}
						data-icon-option={icon.name}
						aria-selected={icon.name === selected}
						aria-label={icon.name}
						title={icon.name}
						data-active={index === clamped || undefined}
						onMouseEnter={() => setActive(index)}
						onClick={() => onSelect(icon.name)}
						className={cn(
							"flex size-8 items-center justify-center rounded-mdly-control text-muted-foreground outline-hidden",
							"data-active:bg-accent data-active:text-foreground",
							icon.name === selected && "bg-selected text-selected-foreground",
						)}
					>
						<SavedViewIconGlyph icon={icon.name} className="size-4" />
					</button>
				))}
				{icons.length === 0 ? (
					<span className="col-span-8 px-2 py-3 text-muted-foreground">
						No icons match
					</span>
				) : null}
			</div>
			<button
				type="button"
				data-icon-reset
				disabled={current === undefined || current === DEFAULT_SAVED_VIEW_ICON}
				onClick={() => onSelect(null)}
				className="flex h-7 items-center gap-1.5 rounded-mdly-control px-2 text-start outline-hidden hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-mdly-ink/20 disabled:opacity-50 disabled:hover:bg-transparent"
			>
				<SavedViewIconGlyph icon={DEFAULT_SAVED_VIEW_ICON} />
				Reset to default
			</button>
		</div>
	);
}
