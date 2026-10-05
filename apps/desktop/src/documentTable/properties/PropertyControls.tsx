import MingcuteAddLine from "~icons/mingcute/add-line";
import MingcuteMore2Line from "~icons/mingcute/more-2-line";
import {
	addPropertyFilter,
	setDocumentTableSort,
	setPropertyGroupBy,
	togglePropertyColumn,
} from "../documentTableStore";
import type { DocumentTableView } from "../documentTableView";
import type { PropertyFilter } from "./documentViews";
import {
	PropertyMenu,
	PropertyMenuItem,
	PropertyMenuLabel,
	PropertyMenuSeparator,
} from "./PropertyMenu";
import type { PropertyField, PropertyFieldId } from "./propertyFields";

/** Values offered as one-click "is" filters in a column menu. */
const MAX_VALUE_FILTERS = 8;

const TYPE_LABELS: Record<PropertyField["type"], string> = {
	text: "Text",
	number: "Number",
	date: "Date",
	boolean: "Checkbox",
	select: "Select",
	multiSelect: "Tags",
};

export const PROPERTY_HEADER_MENU_TRIGGER_CLASS =
	"inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 opacity-0 outline-hidden transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100 aria-expanded:opacity-100";

function valueFilters(field: PropertyField): PropertyFilter[] {
	if (field.type === "boolean") {
		return [
			{ fieldId: field.id, kind: "is", value: true },
			{ fieldId: field.id, kind: "is", value: false },
		];
	}
	if (field.type !== "select" && field.type !== "multiSelect") return [];
	return (field.options ?? [])
		.slice(0, MAX_VALUE_FILTERS)
		.map((value) => ({ fieldId: field.id, kind: "is" as const, value }));
}

function valueLabel(filter: PropertyFilter): string {
	if (filter.kind !== "is") return "";
	if (typeof filter.value === "boolean") return filter.value ? "Yes" : "No";
	return String(filter.value);
}

/** The "⋯" menu on a property column header: sort, group, filter, hide. */
export function PropertyColumnMenu({
	fieldId,
	field,
	label,
	view,
}: {
	fieldId: PropertyFieldId;
	field: PropertyField | undefined;
	label: string;
	view: DocumentTableView;
}) {
	const sortable = field !== undefined && field.type !== "multiSelect";
	const isGrouped = view.propertyGroupBy === fieldId;
	return (
		<PropertyMenu
			trigger={<MingcuteMore2Line aria-hidden="true" className="size-3.5" />}
			triggerClassName={PROPERTY_HEADER_MENU_TRIGGER_CLASS}
			triggerLabel={`${label} options`}
		>
			{field ? (
				<PropertyMenuLabel>
					{TYPE_LABELS[field.type]} · {field.documentCount.toLocaleString()}{" "}
					documents
				</PropertyMenuLabel>
			) : (
				<PropertyMenuLabel>No document has this property</PropertyMenuLabel>
			)}
			{sortable ? (
				<>
					<PropertyMenuItem
						onClick={() =>
							setDocumentTableSort({ column: fieldId, direction: "asc" })
						}
					>
						Sort ascending
					</PropertyMenuItem>
					<PropertyMenuItem
						onClick={() =>
							setDocumentTableSort({ column: fieldId, direction: "desc" })
						}
					>
						Sort descending
					</PropertyMenuItem>
				</>
			) : null}
			<PropertyMenuItem
				onClick={() => setPropertyGroupBy(isGrouped ? null : fieldId)}
			>
				{isGrouped ? "Ungroup" : `Group by ${label}`}
			</PropertyMenuItem>
			<PropertyMenuSeparator />
			<PropertyMenuItem
				onClick={() => addPropertyFilter({ fieldId, kind: "has" })}
			>
				Only documents with {label}
			</PropertyMenuItem>
			{field
				? valueFilters(field).map((filter) => (
						<PropertyMenuItem
							key={valueLabel(filter)}
							onClick={() => addPropertyFilter(filter)}
						>
							{field.type === "multiSelect" ? "Has" : "Is"} {valueLabel(filter)}
						</PropertyMenuItem>
					))
				: null}
			<PropertyMenuSeparator />
			<PropertyMenuItem onClick={() => togglePropertyColumn(fieldId)}>
				Hide column
			</PropertyMenuItem>
		</PropertyMenu>
	);
}

/** "+ Property": the add-a-column menu, every discovered property with its count. */
export function AddPropertyColumnMenu({
	fields,
	visibleColumns,
	isScanning,
}: {
	fields: readonly PropertyField[];
	visibleColumns: readonly PropertyFieldId[];
	isScanning: boolean;
}) {
	return (
		<PropertyMenu
			trigger={
				<>
					<MingcuteAddLine aria-hidden="true" className="size-3.5" />
					<span>Property</span>
				</>
			}
			triggerClassName="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground outline-hidden hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring aria-expanded:bg-accent"
			triggerLabel="Show a front-matter property as a column"
		>
			{fields.length === 0 ? (
				<PropertyMenuLabel>
					{isScanning
						? "Reading front matter…"
						: "No properties yet. Add a line like `status: todo` between `---` lines at the top of a note."}
				</PropertyMenuLabel>
			) : (
				fields.map((field) => (
					<PropertyMenuItem
						key={field.id}
						checked={visibleColumns.includes(field.id)}
						hint={field.documentCount.toLocaleString()}
						onClick={() => togglePropertyColumn(field.id)}
					>
						{field.label}
						<span className="ms-1.5 text-muted-foreground/70">
							{TYPE_LABELS[field.type]}
						</span>
					</PropertyMenuItem>
				))
			)}
		</PropertyMenu>
	);
}
