import { memo } from "react";
import MingcuteMore2Line from "~icons/mingcute/more-2-line";
import { cn } from "../../lib/utils";
import type { DocumentTableRow } from "../documentTableView";
import { PROPERTY_HEADER_MENU_TRIGGER_CLASS } from "../properties/PropertyControls";
import {
	type MenuAnchor,
	PropertyMenuItem,
	PropertyMenuSeparator,
	PropertySubmenu,
	pointerAnchor,
} from "../properties/PropertyMenu";
import {
	fallbackPropertyLabel,
	formatPropertyValue,
	type PropertyField,
	type PropertyFieldId,
} from "../properties/propertyFields";
import { BOARD_COLOR_CLASSES, relativeDateLabel } from "./boardColors";
import type { NoteMoveTarget } from "./NoteCard";
import { startNoteDrag } from "./viewDrag";

/** Tag pills shown before "+N". */
const MAX_TAG_PILLS = 3;

export type BoardCardActions = {
	onOpen: (row: DocumentTableRow) => void;
	moveTargets: (row: DocumentTableRow) => NoteMoveTarget[];
	onMove: (row: DocumentTableRow, columnKey: string) => void;
	onCopyPath?: (row: DocumentTableRow) => void;
	onReveal?: (row: DocumentTableRow) => void;
	revealLabel?: string;
	onDuplicate: (row: DocumentTableRow) => void;
	onRename: (row: DocumentTableRow) => void;
	onDelete: (row: DocumentTableRow) => void;
	/**
	 * Opens the board's one shared card menu for `row`, at `anchor`; focus
	 * returns to `card` when it closes.
	 */
	onOpenMenu: (
		row: DocumentTableRow,
		anchor: MenuAnchor,
		card: HTMLElement,
	) => void;
};

function Chip({
	fieldId,
	field,
	value,
	label,
}: {
	fieldId: PropertyFieldId;
	field: PropertyField | undefined;
	value: unknown;
	label: string;
}) {
	if (Array.isArray(value)) {
		const items = value.map(String).filter((item) => item.length > 0);
		if (items.length === 0) return null;
		const shown = items.slice(0, MAX_TAG_PILLS);
		return (
			<span
				className="flex min-w-0 flex-wrap items-center gap-1"
				title={`${label}: ${items.join(", ")}`}
			>
				{shown.map((item) => (
					<span
						key={item}
						className={cn(
							"max-w-28 truncate rounded-full px-2 text-[10px] leading-4",
							BOARD_COLOR_CLASSES.gray.pill,
						)}
					>
						{item}
					</span>
				))}
				{items.length > shown.length ? (
					<span className="text-[10px] text-muted-foreground">
						+{items.length - shown.length}
					</span>
				) : null}
			</span>
		);
	}
	const text = formatPropertyValue(value as never, fieldId);
	if (text.length === 0) return null;
	if (field?.type === "date" && typeof value === "string") {
		return (
			<span
				className="text-[11px] text-muted-foreground"
				title={`${label}: ${text}`}
			>
				{relativeDateLabel(value)}
			</span>
		);
	}
	if (field?.type === "select") {
		return (
			<span
				className={cn(
					"max-w-full truncate rounded-full px-2 text-[10px] leading-4",
					BOARD_COLOR_CLASSES.blue.pill,
				)}
				title={`${label}: ${text}`}
			>
				{text}
			</span>
		);
	}
	return (
		<span
			className="w-full truncate text-[11px] text-muted-foreground"
			title={`${label}: ${text}`}
		>
			{text}
		</span>
	);
}

/**
 * A board card: title (2 lines) + property chips. Click (or Enter) opens the
 * note, like a table row; drag moves it, "⋯"/right-click offers every action.
 */
export const BoardCard = memo(function BoardCard({
	row,
	title,
	cardProperties,
	fieldById,
	canDrag,
	compact = false,
	actions,
}: {
	row: DocumentTableRow;
	title: string;
	cardProperties: readonly PropertyFieldId[];
	fieldById: ReadonlyMap<PropertyFieldId, PropertyField>;
	canDrag: boolean;
	/** Narrow board beside an open note: title only, one line. */
	compact?: boolean;
	actions: BoardCardActions;
}) {
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: Enter/arrows are handled by the board container.
		<div
			role="button"
			tabIndex={0}
			aria-label={title}
			draggable={canDrag}
			data-note-card={row.path}
			data-board-card={row.path}
			onDragStart={canDrag ? (event) => startNoteDrag(event, row) : undefined}
			aria-current={row.isActive ? "page" : undefined}
			onClick={() => actions.onOpen(row)}
			onContextMenu={(event) => {
				event.preventDefault();
				actions.onOpenMenu(
					row,
					pointerAnchor(event.clientX, event.clientY, event.currentTarget),
					event.currentTarget,
				);
			}}
			className={cn(
				"group flex w-full min-w-0 items-start gap-1 rounded-mdly-control bg-background px-2 py-1.5 text-sm shadow-[var(--shadow-chip)] outline-hidden transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-mdly-ink/20",
				canDrag && "cursor-grab",
				compact && "py-1 text-xs",
				row.isActive && "bg-mdly-selected",
			)}
		>
			<div className="flex min-w-0 flex-1 flex-col items-start gap-1">
				<span
					className={cn(
						"w-full break-words",
						compact ? "line-clamp-1" : "line-clamp-2",
					)}
					title={title}
				>
					{title}
				</span>
				{(compact ? [] : cardProperties).map((fieldId) => (
					<Chip
						key={fieldId}
						fieldId={fieldId}
						field={fieldById.get(fieldId)}
						value={row.properties?.[fieldId]}
						label={
							fieldById.get(fieldId)?.label ?? fallbackPropertyLabel(fieldId)
						}
					/>
				))}
			</div>
			{/* A plain button: the menu itself is one shared instance per board. */}
			<button
				type="button"
				className={PROPERTY_HEADER_MENU_TRIGGER_CLASS}
				aria-label={`Actions for ${title}`}
				aria-haspopup="menu"
				title={`Actions for ${title}`}
				onClick={(event) => {
					event.stopPropagation();
					const card =
						event.currentTarget.closest<HTMLElement>("[data-board-card]");
					actions.onOpenMenu(
						row,
						event.currentTarget,
						card ?? event.currentTarget,
					);
				}}
				onKeyDown={(event) => event.stopPropagation()}
			>
				<MingcuteMore2Line aria-hidden="true" className="size-3.5" />
			</button>
		</div>
	);
});

/** The card menu's items; rendered by the board's shared menu. */
export function CardMenuItems({
	row,
	actions,
}: {
	row: DocumentTableRow;
	actions: BoardCardActions;
}) {
	const targets = actions.moveTargets(row);
	return (
		<>
			<PropertyMenuItem onClick={() => actions.onOpen(row)} hint="↵">
				Open
			</PropertyMenuItem>
			{targets.length > 0 ? (
				<PropertySubmenu label="Move to">
					{targets.map((target) => (
						<PropertyMenuItem
							key={target.key}
							disabled={target.disabled}
							onClick={() => actions.onMove(row, target.key)}
						>
							{target.label}
						</PropertyMenuItem>
					))}
				</PropertySubmenu>
			) : null}
			<PropertyMenuSeparator />
			{actions.onCopyPath ? (
				<PropertyMenuItem onClick={() => actions.onCopyPath?.(row)}>
					Copy path
				</PropertyMenuItem>
			) : null}
			{actions.onReveal ? (
				<PropertyMenuItem onClick={() => actions.onReveal?.(row)}>
					{actions.revealLabel ?? "Reveal in Finder"}
				</PropertyMenuItem>
			) : null}
			<PropertyMenuItem onClick={() => actions.onDuplicate(row)}>
				Duplicate
			</PropertyMenuItem>
			<PropertyMenuItem onClick={() => actions.onRename(row)}>
				Rename…
			</PropertyMenuItem>
			<PropertyMenuSeparator />
			<PropertyMenuItem onClick={() => actions.onDelete(row)}>
				Delete…
			</PropertyMenuItem>
		</>
	);
}
