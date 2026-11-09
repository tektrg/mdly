import { Button } from "@hubble.md/ui";
import { useStoreValue } from "@simplestack/store/react";
import {
	type DragEvent,
	type KeyboardEvent,
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import MingcuteAddLine from "~icons/mingcute/add-line";
import MingcuteMore2Line from "~icons/mingcute/more-2-line";
import { cn } from "../../lib/utils";
import { deleteMarkdownFile, renameMarkdownFile } from "../../store/actions";
import type { DocumentRowListMenu } from "../DocumentRowMenu";
import { setBoardField, updateBoardSettings } from "../documentTableStore";
import type { DocumentTableRow } from "../documentTableView";
import {
	BOARD_COLUMN_COLORS,
	type BoardViewSettings,
	DEFAULT_BOARD_VIEW_SETTINGS,
} from "../properties/documentViews";
import { PROPERTY_HEADER_MENU_TRIGGER_CLASS } from "../properties/PropertyControls";
import {
	AnchoredPropertyMenu,
	type MenuAnchor,
	PropertyMenu,
	PropertyMenuItem,
	PropertyMenuLabel,
	PropertyMenuSeparator,
} from "../properties/PropertyMenu";
import type {
	PropertyField,
	PropertyFieldId,
} from "../properties/propertyFields";
import { propertyScanStore } from "../properties/propertyScanStore";
import { BoardCard, type BoardCardActions, CardMenuItems } from "./BoardCard";
import { type BoardDialogState, BoardDialogs } from "./BoardDialogs";
import {
	createNoteInColumn,
	duplicateNote,
	moveBoardCard,
} from "./boardActions";
import { BOARD_COLOR_CLASSES } from "./boardColors";
import {
	BOARD_COLUMN_CARD_LIMIT,
	type BoardColumn,
	type BoardModel,
	boardColumnKey,
	boardFieldCandidates,
	buildBoardModel,
	cardValue,
	movedBoardValue,
	moveTargetsFor,
	reorderColumnKeys,
	resolveBoardField,
	resolveCardTitle,
	shareBoardColumns,
} from "./boardModel";
import { ReadingPropertiesNotice, ViewFieldPicker } from "./NoteCard";
import { READ_ONLY_MOVE_TARGETS, useNoteDropTarget } from "./viewDrag";

/** Drag payload for a column header (or a hidden-rail entry): its column key. */
const COLUMN_DRAG_TYPE = "application/x-mdly-board-column";
/** Drag payload for a card property row in the Properties popover. */
const CARD_PROPERTY_DRAG_TYPE = "application/x-mdly-card-property";

const EMPTY_HEADINGS: Readonly<Record<string, string>> = {};
const EMPTY_PATHS: readonly string[] = [];

function allColumns(current: BoardModel | null): BoardColumn[] {
	return current ? [...current.columns, ...current.hiddenColumns] : [];
}

function isDroppable(column: BoardColumn): boolean {
	return column.kind === "value" || column.kind === "empty";
}

type ColumnActions = {
	onDropCard: (path: string, column: BoardColumn) => void;
	onDropColumn: (key: string, beforeKey: string | null) => void;
	onShowMore: (column: BoardColumn) => void;
	onCreate: (column: BoardColumn) => void;
	onHide: (column: BoardColumn) => void;
	onColor: (column: BoardColumn, color: BoardColumn["color"]) => void;
};

const BoardColumnView = memo(function BoardColumnView({
	column,
	columnIndex,
	titleOf,
	cardProperties,
	fieldById,
	canDragCards,
	compact,
	cardActions,
	columnActions,
}: {
	column: BoardColumn;
	columnIndex: number;
	titleOf: (row: DocumentTableRow) => string;
	cardProperties: readonly PropertyFieldId[];
	fieldById: ReadonlyMap<PropertyFieldId, PropertyField>;
	canDragCards: boolean;
	compact: boolean;
	cardActions: BoardCardActions;
	columnActions: ColumnActions;
}) {
	const { isDropTarget, dropHandlers } = useNoteDropTarget((path) =>
		columnActions.onDropCard(path, column),
	);
	const [isColumnDropTarget, setIsColumnDropTarget] = useState(false);
	const hidden = column.total - column.rows.length;
	const acceptsCards = isDroppable(column);
	const cardsDraggable = canDragCards && column.kind !== "unreadable";
	const headerDropHandlers = {
		onDragOver: (event: DragEvent<HTMLElement>) => {
			if (!event.dataTransfer.types.includes(COLUMN_DRAG_TYPE)) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "move";
			if (!isColumnDropTarget) setIsColumnDropTarget(true);
		},
		onDragLeave: () => setIsColumnDropTarget(false),
		onDrop: (event: DragEvent<HTMLElement>) => {
			const key = event.dataTransfer.getData(COLUMN_DRAG_TYPE);
			setIsColumnDropTarget(false);
			if (!key) return;
			event.preventDefault();
			event.stopPropagation();
			if (key !== column.key) columnActions.onDropColumn(key, column.key);
		},
	};
	return (
		<section
			aria-label={`${column.label}, ${column.total} notes`}
			data-board-column={column.kind === "value" ? column.value : ""}
			data-board-column-kind={column.kind}
			data-board-column-index={columnIndex}
			{...(acceptsCards ? dropHandlers : {})}
			className={cn(
				"flex h-full shrink-0 flex-col",
				compact ? "w-44" : "w-64",
				" rounded-mdly-control bg-foreground/[0.04]",
				isDropTarget && "ring-[3px] ring-mdly-ink/20",
				isColumnDropTarget && "bg-mdly-selected",
				column.kind === "unreadable" && "opacity-70",
			)}
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: drag-to-reorder handle; the ⋯ menu offers keyboard alternatives. */}
			<header
				draggable
				onDragStart={(event) => {
					event.dataTransfer.effectAllowed = "move";
					event.dataTransfer.setData(COLUMN_DRAG_TYPE, column.key);
				}}
				{...headerDropHandlers}
				className="group flex shrink-0 cursor-grab items-center gap-1.5 px-2 py-1.5 text-xs font-medium"
			>
				<span
					aria-hidden="true"
					className={cn(
						"size-2 shrink-0 rounded-full",
						BOARD_COLOR_CLASSES[column.color].dot,
					)}
				/>
				<span className="min-w-0 truncate" title={column.label}>
					{column.label}
				</span>
				<span className="text-muted-foreground tabular-nums">
					{column.total}
				</span>
				<span className="flex-1" />
				{acceptsCards ? (
					<button
						type="button"
						aria-label={`New note in ${column.label}`}
						title={`New note in ${column.label}`}
						className={PROPERTY_HEADER_MENU_TRIGGER_CLASS}
						onClick={() => columnActions.onCreate(column)}
					>
						<MingcuteAddLine aria-hidden="true" className="size-3.5" />
					</button>
				) : null}
				<PropertyMenu
					trigger={
						<MingcuteMore2Line aria-hidden="true" className="size-3.5" />
					}
					triggerClassName={PROPERTY_HEADER_MENU_TRIGGER_CLASS}
					triggerLabel={`${column.label} column options`}
				>
					<PropertyMenuItem onClick={() => columnActions.onHide(column)}>
						Hide column
					</PropertyMenuItem>
					<PropertyMenuSeparator />
					<PropertyMenuLabel>Colour</PropertyMenuLabel>
					{BOARD_COLUMN_COLORS.map((color) => (
						<PropertyMenuItem
							key={color}
							checked={column.color === color}
							onClick={() => columnActions.onColor(column, color)}
						>
							<span className="inline-flex items-center gap-2">
								<span
									aria-hidden="true"
									className={cn(
										"size-2 rounded-full",
										BOARD_COLOR_CLASSES[color].dot,
									)}
								/>
								{BOARD_COLOR_CLASSES[color].label}
							</span>
						</PropertyMenuItem>
					))}
				</PropertyMenu>
			</header>
			<div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1.5 pb-1.5">
				{column.rows.map((row) => (
					<BoardCard
						key={row.path}
						row={row}
						title={titleOf(row)}
						cardProperties={cardProperties}
						fieldById={fieldById}
						canDrag={cardsDraggable}
						compact={compact}
						actions={cardActions}
					/>
				))}
				{hidden > 0 ? (
					<Button
						size="sm"
						variant="ghost"
						onClick={() => columnActions.onShowMore(column)}
					>
						Show {Math.min(hidden, BOARD_COLUMN_CARD_LIMIT)} more
					</Button>
				) : null}
			</div>
		</section>
	);
});

/** Hidden columns, as a narrow rail at the board's end: click (or drag out) to unhide. */
function HiddenColumnsRail({
	columns,
	onUnhide,
	onDropToHide,
}: {
	columns: readonly BoardColumn[];
	onUnhide: (column: BoardColumn) => void;
	onDropToHide: (key: string) => void;
}) {
	const [isTarget, setIsTarget] = useState(false);
	return (
		<section
			aria-label="Hidden columns"
			data-board-hidden-rail
			onDragOver={(event) => {
				if (!event.dataTransfer.types.includes(COLUMN_DRAG_TYPE)) return;
				event.preventDefault();
				if (!isTarget) setIsTarget(true);
			}}
			onDragLeave={() => setIsTarget(false)}
			onDrop={(event) => {
				setIsTarget(false);
				const key = event.dataTransfer.getData(COLUMN_DRAG_TYPE);
				if (key) {
					event.preventDefault();
					onDropToHide(key);
				}
			}}
			className={cn(
				"flex h-full w-40 shrink-0 flex-col gap-1 rounded-mdly-control px-1.5 py-1.5 text-xs",
				isTarget && "ring-[3px] ring-mdly-ink/20",
			)}
		>
			<span className="px-1 text-[11px] text-muted-foreground">
				Hidden columns
			</span>
			{columns.length === 0 ? (
				<span className="px-1 text-[11px] text-muted-foreground/70">
					Drag a column here to hide it
				</span>
			) : null}
			{columns.map((column) => (
				<button
					key={column.key}
					type="button"
					draggable
					onDragStart={(event) => {
						event.dataTransfer.effectAllowed = "move";
						event.dataTransfer.setData(COLUMN_DRAG_TYPE, column.key);
					}}
					onClick={() => onUnhide(column)}
					title={`Show ${column.label}`}
					className="flex items-center gap-1.5 rounded-mdly-control px-1 py-0.5 text-start hover:bg-accent"
				>
					<span
						aria-hidden="true"
						className={cn(
							"size-2 shrink-0 rounded-full",
							BOARD_COLOR_CLASSES[column.color].dot,
						)}
					/>
					<span className="min-w-0 flex-1 truncate">{column.label}</span>
					<span className="text-muted-foreground tabular-nums">
						{column.total}
					</span>
				</button>
			))}
		</section>
	);
}

/** Toolbar popover: which properties a card shows, and in what order (drag). */
function CardPropertiesPicker({
	fields,
	selected,
	onChange,
}: {
	fields: readonly PropertyField[];
	selected: readonly PropertyFieldId[];
	onChange: (next: PropertyFieldId[]) => void;
}) {
	const fieldById = new Map(fields.map((field) => [field.id, field]));
	const shown = selected.filter((id) => fieldById.has(id));
	const rest = fields.filter((field) => !shown.includes(field.id));
	const dropBefore = (dragged: PropertyFieldId, before: PropertyFieldId) => {
		const next = shown.filter((id) => id !== dragged);
		next.splice(next.indexOf(before), 0, dragged);
		onChange(next);
	};
	return (
		<Popover>
			<PopoverTrigger
				render={
					<Button size="sm" variant="ghost">
						Properties{shown.length > 0 ? ` · ${shown.length}` : ""}
					</Button>
				}
			/>
			<PopoverContent align="start" className="max-h-96 w-60 overflow-y-auto">
				<span className="px-1 text-[10px] text-muted-foreground/70 uppercase">
					Shown on cards
				</span>
				{shown.length === 0 ? (
					<span className="px-1 text-muted-foreground">None</span>
				) : null}
				<ul className="m-0 flex list-none flex-col p-0">
					{shown.map((id) => (
						<li
							key={id}
							draggable
							onDragStart={(event) => {
								event.dataTransfer.effectAllowed = "move";
								event.dataTransfer.setData(CARD_PROPERTY_DRAG_TYPE, id);
							}}
							onDragOver={(event) => {
								if (
									event.dataTransfer.types.includes(CARD_PROPERTY_DRAG_TYPE)
								) {
									event.preventDefault();
								}
							}}
							onDrop={(event) => {
								const dragged = event.dataTransfer.getData(
									CARD_PROPERTY_DRAG_TYPE,
								) as PropertyFieldId;
								if (dragged && dragged !== id) dropBefore(dragged, id);
							}}
							className="flex h-7 cursor-grab items-center gap-2 rounded-mdly-control px-1 hover:bg-accent"
						>
							<span aria-hidden="true" className="text-muted-foreground/70">
								⋮⋮
							</span>
							<label className="flex min-w-0 flex-1 items-center gap-2">
								<input
									type="checkbox"
									checked
									onChange={() =>
										onChange(shown.filter((other) => other !== id))
									}
								/>
								<span className="truncate">{fieldById.get(id)?.label}</span>
							</label>
						</li>
					))}
				</ul>
				{rest.length > 0 ? (
					<span className="px-1 text-[10px] text-muted-foreground/70 uppercase">
						Hidden
					</span>
				) : null}
				<ul className="m-0 flex list-none flex-col p-0">
					{rest.map((field) => (
						<li
							key={field.id}
							className="flex h-7 items-center rounded-mdly-control px-1 ps-5 hover:bg-accent"
						>
							<label className="flex min-w-0 flex-1 items-center gap-2">
								<input
									type="checkbox"
									checked={false}
									onChange={() => onChange([...shown, field.id])}
								/>
								<span className="truncate">{field.label}</span>
							</label>
						</li>
					))}
				</ul>
			</PopoverContent>
		</Popover>
	);
}

/** Right-edge fade while more columns are scrolled out of view. */
function useOverflowFade(columnCount: number) {
	const ref = useRef<HTMLDivElement | null>(null);
	const [fade, setFade] = useState(false);
	const update = useCallback(() => {
		const element = ref.current;
		if (!element) return;
		setFade(element.scrollLeft + element.clientWidth < element.scrollWidth - 1);
	}, []);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		update();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, [update]);
	// Adding/removing columns changes scrollWidth without resizing the viewport.
	// biome-ignore lint/correctness/useExhaustiveDependencies: columnCount is the re-measure trigger.
	useLayoutEffect(update, [update, columnCount]);
	return { ref, fade, onScroll: update };
}

/** Focus target for arrow keys: the card at (column, index), clamped. */
function focusCardAt(
	container: HTMLElement,
	columnIndex: number,
	cardIndex: number,
): boolean {
	const column = container.querySelector<HTMLElement>(
		`[data-board-column-index="${columnIndex}"]`,
	);
	if (!column) return false;
	const cards = column.querySelectorAll<HTMLElement>("[data-board-card]");
	if (cards.length === 0) return false;
	cards[Math.min(cardIndex, cards.length - 1)]?.focus();
	return true;
}

type PendingValues = ReadonlyMap<string, ReturnType<typeof movedBoardValue>>;

/** Rows with in-flight moves applied, so a dropped card lands at once. */
function withPendingValues(
	rows: DocumentTableRow[],
	fieldId: PropertyFieldId | undefined,
	pending: PendingValues,
): DocumentTableRow[] {
	if (!fieldId || pending.size === 0) return rows;
	return rows.map((row) => {
		if (!pending.has(row.path)) return row;
		const value = pending.get(row.path) ?? null;
		return {
			...row,
			properties: {
				...row.properties,
				[fieldId]: typeof value === "boolean" ? String(value) : value,
			},
		};
	});
}

/**
 * Board layout: one column per value of a select field. Columns render at
 * most `BOARD_COLUMN_CARD_LIMIT` cards until "Show more", so a 5k-note board
 * stays a few hundred DOM nodes. Column order, hidden columns, colours and
 * card properties are the view's `board` settings (saved with a saved view).
 */
export function DocumentBoard({
	rows,
	fields,
	boardField,
	boardSettings = DEFAULT_BOARD_VIEW_SETTINGS,
	propertyColumns,
	isReadingProperties = false,
	onOpenDocument,
	rowMenu,
	compact = false,
}: {
	rows: DocumentTableRow[];
	fields: readonly PropertyField[];
	boardField: PropertyFieldId | null;
	boardSettings?: BoardViewSettings;
	propertyColumns: readonly PropertyFieldId[];
	/** The property scan is still running: no field yet is not "no field". */
	isReadingProperties?: boolean;
	onOpenDocument: (row: DocumentTableRow) => void;
	/** File actions shared with the table (copy path, reveal). */
	rowMenu?: DocumentRowListMenu;
	/** Collapsed beside an open note: no toolbar, narrow columns, title-only cards. */
	compact?: boolean;
}) {
	const [limits, setLimits] = useState<Record<string, number>>({});
	const [pending, setPending] = useState<PendingValues>(new Map());
	const [dialog, setDialog] = useState<BoardDialogState>(null);
	// The one card menu, shared by every card (row kept while it animates out).
	const [cardMenu, setCardMenu] = useState<{
		row: DocumentTableRow;
		anchor: MenuAnchor;
		card: HTMLElement;
		open: boolean;
	} | null>(null);
	const focusAfterMove = useRef<string | null>(null);
	const boardRef = useRef<HTMLDivElement | null>(null);
	const headingByPath = useStoreValue(
		propertyScanStore,
		(scan) => scan.headingByPath ?? EMPTY_HEADINGS,
	);
	const invalidPathList = useStoreValue(
		propertyScanStore,
		(scan) => scan.invalidPaths ?? EMPTY_PATHS,
	);
	const invalidPaths = useMemo(
		() => new Set(invalidPathList),
		[invalidPathList],
	);
	const candidates = useMemo(
		() => boardFieldCandidates(fields, rows),
		[fields, rows],
	);
	const field = resolveBoardField(candidates, boardField);
	const effectiveRows = useMemo(
		() => withPendingValues(rows, field?.id, pending),
		[rows, field, pending],
	);
	const previousModel = useRef<BoardModel | null>(null);
	const model = useMemo(() => {
		if (!field) return null;
		const built = buildBoardModel(effectiveRows, field, {
			limitFor: (key) => limits[key] ?? BOARD_COLUMN_CARD_LIMIT,
			invalidPaths,
			settings: boardSettings,
		});
		// Same field: reuse unchanged columns so only the touched ones re-render.
		return previousModel.current?.field === field
			? shareBoardColumns(previousModel.current, built)
			: built;
	}, [effectiveRows, field, limits, invalidPaths, boardSettings]);
	previousModel.current = model;
	const fieldById = useMemo(
		() => new Map(fields.map((candidate) => [candidate.id, candidate])),
		[fields],
	);
	const cardProperties = useMemo(
		() =>
			(boardSettings.cardProperties ?? propertyColumns).filter(
				(id) => id !== field?.id && fieldById.has(id),
			),
		[boardSettings.cardProperties, propertyColumns, field, fieldById],
	);
	const titleOf = useCallback(
		(row: DocumentTableRow) => resolveCardTitle(row, headingByPath[row.path]),
		[headingByPath],
	);
	// Callbacks read props through this ref so a parent re-render with
	// new-but-equal `onOpenDocument`/`rowMenu` keeps `cardActions` stable and
	// leaves every memoized card alone.
	const latest = useRef({
		model,
		effectiveRows,
		titleOf,
		boardSettings,
		invalidPaths,
		onOpenDocument,
		rowMenu,
	});
	latest.current = {
		model,
		effectiveRows,
		titleOf,
		boardSettings,
		invalidPaths,
		onOpenDocument,
		rowMenu,
	};
	const hasRowMenu = rowMenu !== undefined;
	const revealLabel = rowMenu?.revealLabel;

	const moveTo = useCallback((row: DocumentTableRow, target: BoardColumn) => {
		const current = latest.current.model;
		if (!current || !isDroppable(target)) return;
		if (current.field.readOnly) {
			void moveBoardCard({
				row,
				title: latest.current.titleOf(row),
				field: current.field,
				from: target,
				to: target,
			});
			return;
		}
		const fromKey = boardColumnKey(cardValue(row, current.field.id));
		if (fromKey === target.key) return;
		const from = allColumns(current).find(
			(column) => column.key === fromKey,
		) ?? {
			kind: "empty" as const,
			value: null,
		};
		const next = movedBoardValue(row, current.field.id, from, target);
		setPending((map) => new Map(map).set(row.path, next));
		void moveBoardCard({
			row,
			title: latest.current.titleOf(row),
			field: current.field,
			from,
			to: target,
		}).finally(() =>
			setPending((map) => {
				const copy = new Map(map);
				copy.delete(row.path);
				return copy;
			}),
		);
	}, []);

	const cardActions = useMemo<BoardCardActions>(
		() => ({
			onOpen: (row) => latest.current.onOpenDocument(row),
			moveTargets: (row) => {
				const current = latest.current.model;
				if (!current) return [];
				if (current.field.readOnly) return [...READ_ONLY_MOVE_TARGETS];
				if (latest.current.invalidPaths.has(row.path)) return [];
				return moveTargetsFor(row, current).map((column) => ({
					key: column.key,
					label: column.label,
				}));
			},
			onMove: (row, key) => {
				const target = allColumns(latest.current.model).find(
					(column) => column.key === key,
				);
				if (target) moveTo(row, target);
			},
			onCopyPath: hasRowMenu
				? (row) => latest.current.rowMenu?.onCopyPath(row.path)
				: undefined,
			onReveal: hasRowMenu
				? (row) => latest.current.rowMenu?.onRevealPath(row.path)
				: undefined,
			revealLabel,
			onDuplicate: (row) => void duplicateNote(row),
			onRename: (row) =>
				setDialog({ kind: "rename", row, title: latest.current.titleOf(row) }),
			onDelete: (row) =>
				setDialog({ kind: "delete", row, title: latest.current.titleOf(row) }),
			onOpenMenu: (row, anchor, card) =>
				setCardMenu({ row, anchor, card, open: true }),
		}),
		[hasRowMenu, revealLabel, moveTo],
	);

	const columnActions = useMemo<ColumnActions>(
		() => ({
			onDropCard: (path, column) => {
				if (latest.current.invalidPaths.has(path)) return;
				const row = latest.current.effectiveRows.find(
					(candidate) => candidate.path === path,
				);
				if (row) moveTo(row, column);
			},
			onDropColumn: (key, beforeKey) => {
				const keys = allColumns(latest.current.model).map(
					(column) => column.key,
				);
				updateBoardSettings((settings) => ({
					...settings,
					hiddenColumns: settings.hiddenColumns.filter(
						(hidden) => hidden !== key,
					),
					columnOrder: reorderColumnKeys(
						keys,
						settings.columnOrder,
						key,
						beforeKey,
					),
				}));
			},
			onShowMore: (column) =>
				setLimits((current) => ({
					...current,
					[column.key]: column.rows.length + BOARD_COLUMN_CARD_LIMIT,
				})),
			onCreate: (column) => {
				const current = latest.current.model;
				if (current) void createNoteInColumn(current.field, column);
			},
			onHide: (column) =>
				updateBoardSettings((settings) => ({
					...settings,
					hiddenColumns: [...new Set([...settings.hiddenColumns, column.key])],
				})),
			onColor: (column, color) =>
				updateBoardSettings((settings) => ({
					...settings,
					columnColors: { ...settings.columnColors, [column.key]: color },
				})),
		}),
		[moveTo],
	);

	// Keep keyboard focus on a card that Opt+arrow just moved to another column.
	useEffect(() => {
		const path = focusAfterMove.current;
		if (!path || !boardRef.current) return;
		const card = boardRef.current.querySelector<HTMLElement>(
			`[data-board-card="${CSS.escape(path)}"]`,
		);
		if (card) {
			card.focus();
			focusAfterMove.current = null;
		}
	});

	const {
		ref: scrollRef,
		fade,
		onScroll,
	} = useOverflowFade(
		(model?.columns.length ?? 0) + (model?.hiddenColumns.length ?? 0),
	);

	if (!field || !model) {
		if (isReadingProperties) return <ReadingPropertiesNotice />;
		return (
			<p className="m-0 p-3 text-sm text-muted-foreground">
				A board needs a property with a few repeated values, like{" "}
				<code>status: todo</code>, in the notes' front matter.
			</p>
		);
	}

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const card = (event.target as HTMLElement).closest<HTMLElement>(
			"[data-board-card]",
		);
		if (!card || card !== event.target || !boardRef.current) return;
		const columnElement = card.closest<HTMLElement>(
			"[data-board-column-index]",
		);
		const columnIndex = Number(columnElement?.dataset.boardColumnIndex ?? -1);
		const cards = [
			...(columnElement?.querySelectorAll<HTMLElement>("[data-board-card]") ??
				[]),
		];
		const cardIndex = cards.indexOf(card);
		const path = card.dataset.boardCard ?? "";
		const row = effectiveRows.find((candidate) => candidate.path === path);
		if (!row) return;
		if (event.key === "Enter") {
			event.preventDefault();
			onOpenDocument(row);
			return;
		}
		const horizontal =
			event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
		if (event.altKey && horizontal !== 0) {
			event.preventDefault();
			for (
				let index = columnIndex + horizontal;
				index >= 0 && index < model.columns.length;
				index += horizontal
			) {
				const target = model.columns[index];
				if (target && isDroppable(target)) {
					focusAfterMove.current = path;
					cardActions.onMove(row, target.key);
					return;
				}
			}
			return;
		}
		if (horizontal !== 0) {
			event.preventDefault();
			for (
				let index = columnIndex + horizontal;
				index >= 0 && index < model.columns.length;
				index += horizontal
			) {
				if (focusCardAt(boardRef.current, index, Math.max(cardIndex, 0)))
					return;
			}
			return;
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const next = cardIndex + (event.key === "ArrowDown" ? 1 : -1);
			cards[Math.max(0, Math.min(next, cards.length - 1))]?.focus();
		}
	};

	const pickerFields = fields.filter((candidate) => candidate.id !== field.id);

	return (
		<div
			data-board-compact={compact ? "" : undefined}
			className={cn(
				"flex min-h-0 flex-1 flex-col gap-2 pb-2",
				compact ? "px-1" : "px-2",
			)}
		>
			{compact ? null : (
				<div className="flex shrink-0 items-center gap-2 px-1">
					<ViewFieldPicker
						label="Columns by"
						fields={candidates}
						value={field.id}
						onChange={setBoardField}
					/>
					<CardPropertiesPicker
						fields={pickerFields}
						selected={cardProperties}
						onChange={(next) =>
							updateBoardSettings((settings) => ({
								...settings,
								cardProperties: next,
							}))
						}
					/>
					<PropertyMenu
						trigger={
							<span className="inline-flex items-center gap-1 px-1.5 text-[11px]">
								<MingcuteMore2Line aria-hidden="true" className="size-3.5" />
							</span>
						}
						triggerClassName="inline-flex h-7 items-center rounded-mdly-control text-muted-foreground hover:bg-accent hover:text-foreground"
						triggerLabel="Board settings"
						align="start"
					>
						<PropertyMenuItem
							checked={boardSettings.hideEmptyColumns}
							onClick={() =>
								updateBoardSettings((settings) => ({
									...settings,
									hideEmptyColumns: !settings.hideEmptyColumns,
								}))
							}
						>
							Hide empty groups
						</PropertyMenuItem>
						<PropertyMenuSeparator />
						<PropertyMenuItem
							onClick={() =>
								updateBoardSettings(() => DEFAULT_BOARD_VIEW_SETTINGS)
							}
						>
							Reset columns
						</PropertyMenuItem>
					</PropertyMenu>
				</div>
			)}
			<div className="flex min-h-0 flex-1">
				<div className="relative flex min-h-0 min-w-0 flex-1">
					<div
						ref={(element) => {
							scrollRef.current = element;
							boardRef.current = element;
						}}
						role="application"
						aria-label={`Board by ${field.label}`}
						onScroll={onScroll}
						onKeyDown={onKeyDown}
						className="flex min-h-0 min-w-0 flex-1 gap-2 overflow-x-auto"
					>
						{model.columns.map((column, index) => (
							<BoardColumnView
								key={column.key}
								column={column}
								columnIndex={index}
								titleOf={titleOf}
								cardProperties={cardProperties}
								fieldById={fieldById}
								canDragCards={!field.readOnly}
								compact={compact}
								cardActions={cardActions}
								columnActions={columnActions}
							/>
						))}
						<HiddenColumnsRail
							columns={model.hiddenColumns}
							onUnhide={(column) =>
								updateBoardSettings((settings) => ({
									...settings,
									hiddenColumns: settings.hiddenColumns.filter(
										(key) => key !== column.key,
									),
								}))
							}
							onDropToHide={(key) =>
								updateBoardSettings((settings) => ({
									...settings,
									hiddenColumns: [...new Set([...settings.hiddenColumns, key])],
								}))
							}
						/>
					</div>
					{fade ? (
						<div
							aria-hidden="true"
							data-board-overflow-fade
							className="pointer-events-none absolute inset-y-0 end-0 w-10 bg-gradient-to-l from-background to-transparent"
						/>
					) : null}
				</div>
			</div>
			<AnchoredPropertyMenu
				anchor={cardMenu?.anchor ?? null}
				open={cardMenu?.open ?? false}
				returnFocus={cardMenu?.card ?? null}
				label={
					cardMenu ? `Actions for ${titleOf(cardMenu.row)}` : "Card actions"
				}
				onClose={() =>
					setCardMenu((current) =>
						current ? { ...current, open: false } : null,
					)
				}
			>
				{cardMenu ? (
					<CardMenuItems row={cardMenu.row} actions={cardActions} />
				) : null}
			</AnchoredPropertyMenu>
			<BoardDialogs
				state={dialog}
				onClose={() => setDialog(null)}
				onRename={(row, name) => void renameMarkdownFile(row.openPath, name)}
				onDelete={(row) => void deleteMarkdownFile(row.openPath)}
			/>
		</div>
	);
}
