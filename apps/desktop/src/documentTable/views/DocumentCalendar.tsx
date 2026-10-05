import { Button } from "@hubble.md/ui";
import { memo, useMemo, useRef, useState } from "react";
import MingcuteLeftLine from "~icons/mingcute/left-line";
import MingcuteRightLine from "~icons/mingcute/right-line";
import { cn } from "../../lib/utils";
import { setCalendarField } from "../documentTableStore";
import type { DocumentTableRow } from "../documentTableView";
import {
	PropertyMenu,
	PropertyMenuItem,
	PropertyMenuLabel,
} from "../properties/PropertyMenu";
import type {
	PropertyField,
	PropertyFieldId,
} from "../properties/propertyFields";
import {
	buildCalendarModel,
	type CalendarDay,
	type CalendarMonth,
	calendarMoveTargets,
	formatMonthLabel,
	monthOf,
	resolveCalendarField,
	shiftMonth,
} from "./calendarModel";
import {
	NoteCard,
	type NoteMoveTarget,
	ReadingPropertiesNotice,
	ViewFieldPicker,
} from "./NoteCard";
import { useNoteDropTarget, writeDroppedProperty } from "./viewDrag";

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type CalendarActions = {
	moveTargets: (row: DocumentTableRow) => NoteMoveTarget[];
	onMove: (row: DocumentTableRow, date: string) => void;
	onDropPath: (path: string, date: string) => void;
};

/** "+N more": a menu listing every note on the day (opens the chosen one). */
function MoreNotesMenu({
	day,
	hidden,
	onOpenDocument,
}: {
	day: CalendarDay;
	hidden: number;
	onOpenDocument: (row: DocumentTableRow) => void;
}) {
	return (
		<PropertyMenu
			trigger={<>+{hidden} more</>}
			triggerClassName="self-start rounded-sm px-0.5 text-[11px] text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
			triggerLabel={`All ${day.total} notes on ${day.date}`}
			align="start"
		>
			<PropertyMenuLabel>{day.date}</PropertyMenuLabel>
			{day.allRows.map((row) => (
				<PropertyMenuItem key={row.path} onClick={() => onOpenDocument(row)}>
					{row.name}
				</PropertyMenuItem>
			))}
		</PropertyMenu>
	);
}

const CalendarDayCell = memo(function CalendarDayCell({
	day,
	actions,
	onOpenDocument,
}: {
	day: CalendarDay;
	actions: CalendarActions;
	onOpenDocument: (row: DocumentTableRow) => void;
}) {
	const { isDropTarget, dropHandlers } = useNoteDropTarget((path) =>
		actions.onDropPath(path, day.date),
	);
	const hidden = day.total - day.rows.length;
	return (
		<div
			role="gridcell"
			tabIndex={-1}
			aria-label={`${day.date}, ${day.total} notes`}
			data-calendar-day={day.date}
			{...dropHandlers}
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
					moveTargets={actions.moveTargets}
					onMove={actions.onMove}
					onOpenDocument={onOpenDocument}
				/>
			))}
			{hidden > 0 ? (
				<MoreNotesMenu
					day={day}
					hidden={hidden}
					onOpenDocument={onOpenDocument}
				/>
			) : null}
		</div>
	);
});

/** Remove-date target key (a date key is always `YYYY-MM-DD`). */
const REMOVE_DATE_KEY = "none";

function useCalendarActions(
	field: PropertyField | null,
	rows: readonly DocumentTableRow[],
): CalendarActions {
	const latest = useRef({ field, rows });
	latest.current = { field, rows };
	return useMemo<CalendarActions>(() => {
		const moveTo = (row: DocumentTableRow, date: string | null) => {
			const current = latest.current.field;
			if (!current) return;
			// Dropped on its own day: nothing to write.
			if ((row.properties?.[current.id] ?? null) === date) return;
			void writeDroppedProperty(row, current, date);
		};
		return {
			moveTargets: (row) => {
				const current = latest.current.field;
				const date = current ? row.properties?.[current.id] : null;
				if (typeof date !== "string") return [];
				return calendarMoveTargets(date).map((target) => ({
					key: target.date ?? REMOVE_DATE_KEY,
					label: target.label,
				}));
			},
			onMove: (row, key) => moveTo(row, key === REMOVE_DATE_KEY ? null : key),
			onDropPath: (path, date) => {
				const row = latest.current.rows.find(
					(candidate) => candidate.path === path,
				);
				if (row) moveTo(row, date);
			},
		};
	}, []);
}

/** Calendar layout: a month grid of notes by a date property. */
export function DocumentCalendar({
	rows,
	fields,
	calendarField,
	isReadingProperties = false,
	onOpenDocument,
}: {
	rows: DocumentTableRow[];
	fields: readonly PropertyField[];
	calendarField: PropertyFieldId | null;
	/** The property scan is still running: no field yet is not "no field". */
	isReadingProperties?: boolean;
	onOpenDocument: (row: DocumentTableRow) => void;
}) {
	const [month, setMonth] = useState<CalendarMonth>(() => monthOf(new Date()));
	const field = resolveCalendarField(fields, calendarField);
	const model = useMemo(
		() => (field ? buildCalendarModel(rows, field, month) : null),
		[rows, field, month],
	);
	const actions = useCalendarActions(field, rows);
	if (!field || !model) {
		if (isReadingProperties) return <ReadingPropertiesNotice />;
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
							actions={actions}
							onOpenDocument={onOpenDocument}
						/>
					))}
				</div>
			</div>
		</div>
	);
}
