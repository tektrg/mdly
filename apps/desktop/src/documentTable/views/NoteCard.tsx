import { memo } from "react";
import MingcuteMore2Line from "~icons/mingcute/more-2-line";
import { cn } from "../../lib/utils";
import type { DocumentTableRow } from "../documentTableView";
import { PROPERTY_HEADER_MENU_TRIGGER_CLASS } from "../properties/PropertyControls";
import {
	PropertyMenu,
	PropertyMenuItem,
	PropertyMenuLabel,
} from "../properties/PropertyMenu";
import {
	fallbackPropertyLabel,
	formatPropertyValue,
	type PropertyField,
	type PropertyFieldId,
} from "../properties/propertyFields";
import { startNoteDrag } from "./viewDrag";

/** Properties shown on a board card; the rest stay in the table. */
const MAX_CARD_PROPERTIES = 3;

/** One keyboard-reachable alternative to a drag. */
export type NoteMoveTarget = { key: string; label: string; disabled?: boolean };

const EMPTY_COLUMNS: readonly PropertyFieldId[] = [];
const EMPTY_LABELS: ReadonlyMap<PropertyFieldId, string> = new Map();

/**
 * A draggable note: click opens it, drag moves it to another column or day,
 * and the "⋯" menu offers the same moves from the keyboard.
 */
export const NoteCard = memo(function NoteCard({
	row,
	propertyColumns = EMPTY_COLUMNS,
	labelById = EMPTY_LABELS,
	compact = false,
	canDrag = true,
	moveTargets,
	onMove,
	onOpenDocument,
}: {
	row: DocumentTableRow;
	/** The view's property columns, shown under the title (board only). */
	propertyColumns?: readonly PropertyFieldId[];
	/** Field labels, built once per board (not per card). */
	labelById?: ReadonlyMap<PropertyFieldId, string>;
	compact?: boolean;
	/** False on a read-only (built-in) field: the card cannot be dragged. */
	canDrag?: boolean;
	/** Computed when the menu opens, so idle cards cost nothing. */
	moveTargets: (row: DocumentTableRow) => NoteMoveTarget[];
	onMove: (row: DocumentTableRow, targetKey: string) => void;
	onOpenDocument: (row: DocumentTableRow) => void;
}) {
	const shown = propertyColumns
		.map((fieldId) => ({
			fieldId,
			text: formatPropertyValue(row.properties?.[fieldId], fieldId),
		}))
		.filter((entry) => entry.text.length > 0)
		.slice(0, MAX_CARD_PROPERTIES);
	return (
		<div
			role="group"
			aria-label={row.name}
			draggable={canDrag}
			data-note-card={row.path}
			onDragStart={canDrag ? (event) => startNoteDrag(event, row) : undefined}
			className={cn(
				"group flex w-full min-w-0 items-start gap-1 rounded-[var(--radius-row)] border border-border bg-background transition-colors hover:bg-accent",
				compact ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1.5 text-sm",
				canDrag && "cursor-grab",
				row.isActive && "border-ring",
			)}
		>
			<button
				type="button"
				onClick={() => onOpenDocument(row)}
				title={row.name}
				className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-start outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
			>
				<span className="w-full truncate">{row.name}</span>
				{shown.map(({ fieldId, text }) => (
					<span
						key={fieldId}
						className="w-full truncate text-[11px] text-muted-foreground"
					>
						{labelById.get(fieldId) ?? fallbackPropertyLabel(fieldId)}: {text}
					</span>
				))}
			</button>
			<PropertyMenu
				trigger={<MingcuteMore2Line aria-hidden="true" className="size-3.5" />}
				triggerClassName={PROPERTY_HEADER_MENU_TRIGGER_CLASS}
				triggerLabel={`Move ${row.name}`}
			>
				<MoveToItems row={row} moveTargets={moveTargets} onMove={onMove} />
			</PropertyMenu>
		</div>
	);
});

/** Rendered only while the menu is open, so targets are computed lazily. */
function MoveToItems({
	row,
	moveTargets,
	onMove,
}: {
	row: DocumentTableRow;
	moveTargets: (row: DocumentTableRow) => NoteMoveTarget[];
	onMove: (row: DocumentTableRow, targetKey: string) => void;
}) {
	return (
		<>
			<PropertyMenuLabel>Move to</PropertyMenuLabel>
			{moveTargets(row).map((target) => (
				<PropertyMenuItem
					key={target.key}
					disabled={target.disabled}
					onClick={() => onMove(row, target.key)}
				>
					{target.label}
				</PropertyMenuItem>
			))}
		</>
	);
}

/** Field id → label, for card property lines. */
export function fieldLabelMap(
	fields: readonly PropertyField[],
): ReadonlyMap<PropertyFieldId, string> {
	return new Map(fields.map((field) => [field.id, field.label]));
}

/** Native picker for the field a board or calendar reads. */
export function ViewFieldPicker({
	label,
	fields,
	value,
	onChange,
}: {
	label: string;
	fields: readonly PropertyField[];
	value: PropertyFieldId | null;
	onChange: (fieldId: PropertyFieldId) => void;
}) {
	return (
		<label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
			{label}
			<select
				className="h-7 rounded-[var(--radius-row)] border border-border bg-background px-1.5 text-xs text-foreground"
				value={value ?? ""}
				onChange={(event) => onChange(event.target.value as PropertyFieldId)}
			>
				{fields.map((field) => (
					<option key={field.id} value={field.id}>
						{field.label}
					</option>
				))}
			</select>
		</label>
	);
}

/** Shown instead of "needs a property" while the scan has not finished. */
export function ReadingPropertiesNotice() {
	return (
		<p aria-busy="true" className="m-0 p-3 text-sm text-muted-foreground">
			Reading properties…
		</p>
	);
}
