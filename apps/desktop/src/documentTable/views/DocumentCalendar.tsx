import { Button } from "@hubble.md/ui";
import { useMemo, useState } from "react";
import MingcuteLeftLine from "~icons/mingcute/left-line";
import MingcuteRightLine from "~icons/mingcute/right-line";
import { cn } from "../../lib/utils";
import { setCalendarField } from "../documentTableStore";
import type { DocumentTableRow } from "../documentTableView";
import type {
	PropertyField,
	PropertyFieldId,
} from "../properties/propertyFields";
import {
	buildCalendarModel,
	type CalendarDay,
	type CalendarMonth,
	formatMonthLabel,
	monthOf,
	resolveCalendarField,
	shiftMonth,
} from "./calendarModel";
import { NoteCard, ViewFieldPicker } from "./NoteCard";
import { draggedNotePath, isNoteDrag, writeDroppedProperty } from "./viewDrag";

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function CalendarDayCell({
	day,
	field,
	rowByPath,
	onOpenDocument,
}: {
	day: CalendarDay;
	field: PropertyField;
	rowByPath: ReadonlyMap<string, DocumentTableRow>;
	onOpenDocument: (row: DocumentTableRow) => void;
}) {
	const [isDropTarget, setIsDropTarget] = useState(false);
	const hidden = day.total - day.rows.length;
	return (
		<div
			role="gridcell"
			tabIndex={-1}
			aria-label={`${day.date}, ${day.total} notes`}
			data-calendar-day={day.date}
			onDragOver={(event) => {
				if (!isNoteDrag(event)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "move";
				setIsDropTarget(true);
			}}
			onDragLeave={() => setIsDropTarget(false)}
			onDrop={(event) => {
				event.preventDefault();
				setIsDropTarget(false);
				const row = rowByPath.get(draggedNotePath(event) ?? "");
				if (row) void writeDroppedProperty(row, field, day.date);
			}}
			className={cn(
				"flex min-h-0 min-w-0 flex-col gap-0.5 overflow-hidden border-border border-t p-1",
				!day.inMonth && "bg-muted/30 text-muted-foreground",
				isDropTarget && "ring-1 ring-ring ring-inset",
			)}
		>
			<span className="shrink-0 text-[11px] tabular-nums">
				{day.dayOfMonth}
			</span>
			{day.rows.map((row) => (
				<NoteCard
					key={row.path}
					row={row}
					compact
					onOpenDocument={onOpenDocument}
				/>
			))}
			{hidden > 0 ? (
				<span className="text-[11px] text-muted-foreground">
					+{hidden} more
				</span>
			) : null}
		</div>
	);
}

/** Calendar layout: a month grid of notes by a date property. */
export function DocumentCalendar({
	rows,
	fields,
	calendarField,
	onOpenDocument,
}: {
	rows: DocumentTableRow[];
	fields: readonly PropertyField[];
	calendarField: PropertyFieldId | null;
	onOpenDocument: (row: DocumentTableRow) => void;
}) {
	const [month, setMonth] = useState<CalendarMonth>(() => monthOf(new Date()));
	const field = resolveCalendarField(fields, calendarField);
	const model = useMemo(
		() => (field ? buildCalendarModel(rows, field, month) : null),
		[rows, field, month],
	);
	const rowByPath = useMemo(
		() => new Map(rows.map((row) => [row.path, row])),
		[rows],
	);
	if (!field || !model) {
		return (
			<p className="m-0 p-3 text-sm text-muted-foreground">
				A calendar needs a date property, like <code>due: 2026-10-05</code>, in
				the notes' front matter.
			</p>
		);
	}
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-2 px-2 pb-2">
			<div className="flex shrink-0 flex-wrap items-center gap-2 px-1">
				<Button
					size="sm"
					variant="ghost"
					aria-label="Previous month"
					onClick={() => setMonth((current) => shiftMonth(current, -1))}
				>
					<MingcuteLeftLine aria-hidden="true" className="size-3.5" />
				</Button>
				<h2 className="m-0 min-w-36 text-center text-sm font-medium">
					{formatMonthLabel(month)}
				</h2>
				<Button
					size="sm"
					variant="ghost"
					aria-label="Next month"
					onClick={() => setMonth((current) => shiftMonth(current, 1))}
				>
					<MingcuteRightLine aria-hidden="true" className="size-3.5" />
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onClick={() => setMonth(monthOf(new Date()))}
				>
					Today
				</Button>
				<ViewFieldPicker
					label="Dates from"
					fields={fields.filter((candidate) => candidate.type === "date")}
					value={field.id}
					onChange={setCalendarField}
				/>
				{model.undatedCount > 0 ? (
					<span className="text-[11px] text-muted-foreground">
						{model.undatedCount} without {field.label}
					</span>
				) : null}
			</div>
			<div
				role="grid"
				aria-label={`Notes by ${field.label}`}
				className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border"
			>
				<div role="row" tabIndex={-1} className="grid shrink-0 grid-cols-7">
					{WEEKDAY_LABELS.map((label) => (
						<div
							key={label}
							role="columnheader"
							tabIndex={-1}
							className="px-1 py-0.5 text-[11px] text-muted-foreground uppercase"
						>
							{label}
						</div>
					))}
				</div>
				<div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-7">
					{model.weeks.flat().map((day) => (
						<CalendarDayCell
							key={day.date}
							day={day}
							field={field}
							rowByPath={rowByPath}
							onOpenDocument={onOpenDocument}
						/>
					))}
				</div>
			</div>
		</div>
	);
}
