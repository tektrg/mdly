import { Button } from "@hubble.md/ui";
import { useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import { setBoardField } from "../documentTableStore";
import type { DocumentTableRow } from "../documentTableView";
import type {
	PropertyField,
	PropertyFieldId,
} from "../properties/propertyFields";
import {
	BOARD_COLUMN_CARD_LIMIT,
	type BoardColumn,
	buildBoardModel,
	isBoardField,
	resolveBoardField,
} from "./boardModel";
import { NoteCard, ViewFieldPicker } from "./NoteCard";
import { draggedNotePath, isNoteDrag, writeDroppedProperty } from "./viewDrag";

function columnKey(value: string | null): string {
	return value === null ? "\u0000empty" : value;
}

function BoardColumnView({
	column,
	field,
	rowByPath,
	propertyColumns,
	fields,
	onOpenDocument,
	onShowMore,
}: {
	column: BoardColumn;
	field: PropertyField;
	rowByPath: ReadonlyMap<string, DocumentTableRow>;
	propertyColumns: readonly PropertyFieldId[];
	fields: readonly PropertyField[];
	onOpenDocument: (row: DocumentTableRow) => void;
	onShowMore: () => void;
}) {
	const [isDropTarget, setIsDropTarget] = useState(false);
	const hidden = column.total - column.rows.length;
	return (
		<section
			aria-label={`${column.label}, ${column.total} notes`}
			data-board-column={column.value ?? ""}
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
				if (row) void writeDroppedProperty(row, field, column.value);
			}}
			className={cn(
				"flex h-full w-64 shrink-0 flex-col rounded-md bg-muted/40",
				isDropTarget && "ring-1 ring-ring",
			)}
		>
			<header className="flex shrink-0 items-center justify-between gap-2 px-2 py-1.5 text-xs font-medium">
				<span className="truncate">{column.label}</span>
				<span className="text-muted-foreground tabular-nums">
					{column.total}
				</span>
			</header>
			<div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1.5 pb-1.5">
				{column.rows.map((row) => (
					<NoteCard
						key={row.path}
						row={row}
						propertyColumns={propertyColumns}
						fields={fields}
						onOpenDocument={onOpenDocument}
					/>
				))}
				{hidden > 0 ? (
					<Button size="sm" variant="ghost" onClick={onShowMore}>
						Show {Math.min(hidden, BOARD_COLUMN_CARD_LIMIT)} more
					</Button>
				) : null}
			</div>
		</section>
	);
}

/**
 * Board layout: one column per value of a select field. Columns render at
 * most `BOARD_COLUMN_CARD_LIMIT` cards until "Show more", so a 5k-note board
 * stays a few hundred DOM nodes.
 */
export function DocumentBoard({
	rows,
	fields,
	boardField,
	propertyColumns,
	onOpenDocument,
}: {
	rows: DocumentTableRow[];
	fields: readonly PropertyField[];
	boardField: PropertyFieldId | null;
	propertyColumns: readonly PropertyFieldId[];
	onOpenDocument: (row: DocumentTableRow) => void;
}) {
	const [limits, setLimits] = useState<Record<string, number>>({});
	const field = resolveBoardField(fields, boardField);
	const model = useMemo(
		() =>
			field
				? buildBoardModel(
						rows,
						field,
						(value) => limits[columnKey(value)] ?? BOARD_COLUMN_CARD_LIMIT,
					)
				: null,
		[rows, field, limits],
	);
	const rowByPath = useMemo(
		() => new Map(rows.map((row) => [row.path, row])),
		[rows],
	);
	if (!field || !model) {
		return (
			<p className="m-0 p-3 text-sm text-muted-foreground">
				A board needs a property with a few repeated values, like{" "}
				<code>status: todo</code>, in the notes' front matter.
			</p>
		);
	}
	const cardColumns = propertyColumns.filter((id) => id !== field.id);
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-2 px-2 pb-2">
			<div className="flex shrink-0 items-center px-1">
				<ViewFieldPicker
					label="Columns by"
					fields={fields.filter(isBoardField)}
					value={field.id}
					onChange={setBoardField}
				/>
			</div>
			<div className="flex min-h-0 flex-1 gap-2 overflow-x-auto">
				{model.columns.map((column) => (
					<BoardColumnView
						key={columnKey(column.value)}
						column={column}
						field={field}
						rowByPath={rowByPath}
						propertyColumns={cardColumns}
						fields={fields}
						onOpenDocument={onOpenDocument}
						onShowMore={() =>
							setLimits((current) => ({
								...current,
								[columnKey(column.value)]:
									column.rows.length + BOARD_COLUMN_CARD_LIMIT,
							}))
						}
					/>
				))}
			</div>
		</div>
	);
}
