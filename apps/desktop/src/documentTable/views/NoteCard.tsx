import { cn } from "../../lib/utils";
import type { DocumentTableRow } from "../documentTableView";
import {
	fallbackPropertyLabel,
	formatPropertyValue,
	type PropertyField,
	type PropertyFieldId,
} from "../properties/propertyFields";
import { startNoteDrag } from "./viewDrag";

/** Properties shown on a board card; the rest stay in the table. */
const MAX_CARD_PROPERTIES = 3;

/** A draggable note: click opens it, drag moves it to another column or day. */
export function NoteCard({
	row,
	propertyColumns = [],
	fields = [],
	compact = false,
	onOpenDocument,
}: {
	row: DocumentTableRow;
	/** The view's property columns, shown under the title (board only). */
	propertyColumns?: readonly PropertyFieldId[];
	fields?: readonly PropertyField[];
	compact?: boolean;
	onOpenDocument: (row: DocumentTableRow) => void;
}) {
	const shown = propertyColumns
		.map((fieldId) => ({
			fieldId,
			text: formatPropertyValue(row.properties?.[fieldId]),
		}))
		.filter((entry) => entry.text.length > 0)
		.slice(0, MAX_CARD_PROPERTIES);
	return (
		<button
			type="button"
			draggable
			data-note-card={row.path}
			onDragStart={(event) => startNoteDrag(event, row)}
			onClick={() => onOpenDocument(row)}
			title={row.name}
			className={cn(
				"flex w-full min-w-0 cursor-grab flex-col items-start gap-0.5 rounded-[var(--radius-row)] border border-border bg-background text-start outline-hidden transition-colors hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring",
				compact ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1.5 text-sm",
				row.isActive && "border-ring",
			)}
		>
			<span className="w-full truncate">{row.name}</span>
			{shown.map(({ fieldId, text }) => (
				<span
					key={fieldId}
					className="w-full truncate text-[11px] text-muted-foreground"
				>
					{fields.find((field) => field.id === fieldId)?.label ??
						fallbackPropertyLabel(fieldId)}
					: {text}
				</span>
			))}
		</button>
	);
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
