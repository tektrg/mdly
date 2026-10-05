/**
 * Group-by-property (design note phase 2/3; precursor of the kanban in step 5).
 *
 * The grouping itself is table-core's: `evaluate` with a `groupBy` key, whose
 * group tree is then re-shaped into the nav list's `NavGroupNode` so the
 * existing header rows, expand state and virtualized flattening render it with
 * no second list implementation.
 */
import { evaluate, type GroupNode, type RowValue } from "@tektrg/table-core";
import type { DocumentTableRow } from "../documentTableView";
import type { NavGroupNode } from "../navGroupTree";
import {
	fallbackPropertyLabel,
	formatPropertyValue,
	type PropertyField,
	type PropertyFieldId,
} from "./propertyFields";

/** Group ids are namespaced, so a "Done" status never shares expand state with a "Done" folder. */
export function propertyGroupId(
	fieldId: PropertyFieldId,
	key: RowValue,
): string {
	return key === null || key === undefined
		? `${fieldId}::(empty)`
		: `${fieldId}::${String(key)}`;
}

function emptyGroupLabel(
	field: PropertyField | undefined,
	fieldId: PropertyFieldId,
) {
	return `No ${field?.label ?? fallbackPropertyLabel(fieldId)}`;
}

function toNavNode(
	group: GroupNode,
	fieldId: PropertyFieldId,
	field: PropertyField | undefined,
): NavGroupNode {
	const paths = (group.rows ?? []).map((row) => String(row.id));
	const isEmpty = group.key === null || group.key === undefined;
	const label = isEmpty
		? emptyGroupLabel(field, fieldId)
		: formatPropertyValue(group.key);
	return {
		id: propertyGroupId(fieldId, group.key),
		segment: label,
		label,
		depth: 0,
		members: new Set(paths),
		ownPaths: paths,
		children: [],
		// Read-only in this step: dropping onto a status group (= writing the
		// property) arrives with the kanban.
		droppable: false,
		collapsedByDefault: false,
		isFallback: isEmpty,
	};
}

/**
 * Rows (already filtered and sorted) grouped on one property, as a nav tree
 * root. Groups follow the value order (caseless for text), the empty group
 * last; rows inside a group keep the caller's order.
 */
export function buildPropertyGroupTree(
	rows: readonly DocumentTableRow[],
	fieldId: PropertyFieldId,
	fields: readonly PropertyField[],
): NavGroupNode {
	const field = fields.find((candidate) => candidate.id === fieldId);
	const root: NavGroupNode = {
		id: "",
		segment: "",
		label: "",
		depth: -1,
		members: new Set(rows.map((row) => row.path)),
		ownPaths: [],
		children: [],
		droppable: false,
		collapsedByDefault: false,
		isFallback: false,
	};
	if (!field) {
		// No document carries this property (any more): one honest empty group.
		const allPaths = rows.map((row) => row.path);
		root.children.push(
			toNavNode(
				{
					fieldId,
					key: null,
					rowCount: allPaths.length,
					rows: rows.map((row) => ({ id: row.path })),
				},
				fieldId,
				undefined,
			),
		);
		return rows.length === 0 ? { ...root, children: [] } : root;
	}
	const isText = field.type === "text" || field.type === "select";
	const result = evaluate(
		{
			specVersion: 1,
			viewType: "table",
			groupBy: [
				{
					fieldId,
					direction: "asc",
					...(isText || field.type === "multiSelect"
						? { collation: "caseless" as const }
						: {}),
				},
			],
			tieBreak: "sourceOrder",
		},
		rows.map((row) => ({
			id: row.path,
			[fieldId]: row.properties?.[fieldId] ?? null,
		})),
		[field],
	);
	if (!result.ok) {
		throw new Error(`property grouping rejected: ${result.errors[0]?.message}`);
	}
	root.children = result.groups.map((group) =>
		toNavNode(group, fieldId, field),
	);
	return root;
}
