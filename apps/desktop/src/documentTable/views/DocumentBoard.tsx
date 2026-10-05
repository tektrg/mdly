import { Button } from "@hubble.md/ui";
import { memo, useMemo, useRef, useState } from "react";
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
	type BoardModel,
	boardFieldCandidates,
	buildBoardModel,
	cardValue,
	moveTargetsFor,
	resolveBoardField,
} from "./boardModel";
import {
	fieldLabelMap,
	NoteCard,
	type NoteMoveTarget,
	ReadingPropertiesNotice,
	ViewFieldPicker,
} from "./NoteCard";
import {
	READ_ONLY_MOVE_TARGETS,
	useNoteDropTarget,
	writeDroppedProperty,
} from "./viewDrag";

type BoardActions = {
	moveTargets: (row: DocumentTableRow) => NoteMoveTarget[];
	onMove: (row: DocumentTableRow, columnKey: string) => void;
	onDropPath: (path: string, column: BoardColumn) => void;
	onShowMore: (column: BoardColumn) => void;
};

const BoardColumnView = memo(function BoardColumnView({
	column,
	propertyColumns,
	labelById,
	actions,
	onOpenDocument,
}: {
	column: BoardColumn;
	propertyColumns: readonly PropertyFieldId[];
	labelById: ReadonlyMap<PropertyFieldId, string>;
	actions: BoardActions;
	onOpenDocument: (row: DocumentTableRow) => void;
}) {
	const { isDropTarget, dropHandlers } = useNoteDropTarget((path) =>
		actions.onDropPath(path, column),
	);
	const hidden = column.total - column.rows.length;
	const acceptsDrops = column.kind !== "other";
	return (
		<section
			aria-label={`${column.label}, ${column.total} notes`}
			data-board-column={column.kind === "value" ? column.value : ""}
			data-board-column-kind={column.kind}
			{...(acceptsDrops ? dropHandlers : {})}
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
						labelById={labelById}
						moveTargets={actions.moveTargets}
						onMove={actions.onMove}
						onOpenDocument={onOpenDocument}
					/>
				))}
				{hidden > 0 ? (
					<Button
						size="sm"
						variant="ghost"
						onClick={() => actions.onShowMore(column)}
					>
						Show {Math.min(hidden, BOARD_COLUMN_CARD_LIMIT)} more
					</Button>
				) : null}
			</div>
		</section>
	);
});

/** Drag, keyboard move and "show more", stable across renders (columns stay memoized). */
function useBoardActions(
	model: BoardModel | null,
	rows: readonly DocumentTableRow[],
	setLimits: (
		update: (limits: Record<string, number>) => Record<string, number>,
	) => void,
): BoardActions {
	const latest = useRef({ model, rows });
	latest.current = { model, rows };
	return useMemo<BoardActions>(() => {
		const moveTo = (row: DocumentTableRow, column: BoardColumn) => {
			const current = latest.current.model;
			if (!current || column.kind === "other") return;
			// Dropped on its own column: nothing to write.
			if (cardValue(row, current.field.id) === column.value) return;
			void writeDroppedProperty(row, current.field, column.value);
		};
		const columnByKey = (key: string) =>
			latest.current.model?.columns.find((column) => column.key === key);
		return {
			moveTargets: (row) => {
				const current = latest.current.model;
				if (!current) return [];
				if (current.field.readOnly) return [...READ_ONLY_MOVE_TARGETS];
				return moveTargetsFor(row, current).map((column) => ({
					key: column.key,
					label: column.label,
				}));
			},
			onMove: (row, key) => {
				const column = columnByKey(key);
				if (column) moveTo(row, column);
			},
			onDropPath: (path, column) => {
				const row = latest.current.rows.find(
					(candidate) => candidate.path === path,
				);
				if (row) moveTo(row, column);
			},
			onShowMore: (column) =>
				setLimits((limits) => ({
					...limits,
					[column.key]: column.rows.length + BOARD_COLUMN_CARD_LIMIT,
				})),
		};
	}, [setLimits]);
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
	isReadingProperties = false,
	onOpenDocument,
}: {
	rows: DocumentTableRow[];
	fields: readonly PropertyField[];
	boardField: PropertyFieldId | null;
	propertyColumns: readonly PropertyFieldId[];
	/** The property scan is still running: no field yet is not "no field". */
	isReadingProperties?: boolean;
	onOpenDocument: (row: DocumentTableRow) => void;
}) {
	const [limits, setLimits] = useState<Record<string, number>>({});
	const candidates = useMemo(
		() => boardFieldCandidates(fields, rows),
		[fields, rows],
	);
	const field = resolveBoardField(candidates, boardField);
	const model = useMemo(
		() =>
			field
				? buildBoardModel(
						rows,
						field,
						(key) => limits[key] ?? BOARD_COLUMN_CARD_LIMIT,
					)
				: null,
		[rows, field, limits],
	);
	const labelById = useMemo(() => fieldLabelMap(fields), [fields]);
	const cardColumns = useMemo(
		() => propertyColumns.filter((id) => id !== field?.id),
		[propertyColumns, field],
	);
	const actions = useBoardActions(model, rows, setLimits);
	if (!field || !model) {
		if (isReadingProperties) return <ReadingPropertiesNotice />;
		return (
			<p className="m-0 p-3 text-sm text-muted-foreground">
				A board needs a property with a few repeated values, like{" "}
				<code>status: todo</code>, in the notes' front matter.
			</p>
		);
	}
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-2 px-2 pb-2">
			<div className="flex shrink-0 items-center px-1">
				<ViewFieldPicker
					label="Columns by"
					fields={candidates}
					value={field.id}
					onChange={setBoardField}
				/>
			</div>
			<div className="flex min-h-0 flex-1 gap-2 overflow-x-auto">
				{model.columns.map((column) => (
					<BoardColumnView
						key={column.key}
						column={column}
						propertyColumns={cardColumns}
						labelById={labelById}
						actions={actions}
						onOpenDocument={onOpenDocument}
					/>
				))}
			</div>
		</div>
	);
}
