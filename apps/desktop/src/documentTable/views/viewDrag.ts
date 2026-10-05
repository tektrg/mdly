import type { FrontMatterEditValue } from "@mdly/workspace-kit/engine";
import type { DragEvent } from "react";
import { toast } from "sonner";
import type { DocumentTableRow } from "../documentTableView";
import type { PropertyField } from "../properties/propertyFields";
import { writeDocumentProperty } from "../properties/propertyWrite";

/** Drag payload type for a note card; the value is the row's listing path. */
const NOTE_DRAG_TYPE = "application/x-mdly-note-path";

export function startNoteDrag(event: DragEvent, row: DocumentTableRow) {
	event.dataTransfer.effectAllowed = "move";
	event.dataTransfer.setData(NOTE_DRAG_TYPE, row.path);
}

export function isNoteDrag(event: DragEvent): boolean {
	return event.dataTransfer.types.includes(NOTE_DRAG_TYPE);
}

export function draggedNotePath(event: DragEvent): string | null {
	return event.dataTransfer.getData(NOTE_DRAG_TYPE) || null;
}

/**
 * A card dropped on a column/day: rewrite that one front-matter key. The key
 * is the field's label (its commonest spelling); the edit matches any casing
 * already in the file. A refusal is shown, never swallowed.
 */
export async function writeDroppedProperty(
	row: DocumentTableRow,
	field: PropertyField,
	value: FrontMatterEditValue | null,
): Promise<boolean> {
	const result = await writeDocumentProperty(row, field.label, value);
	if (!result.ok) {
		toast.error(`Could not update “${row.name}”`, {
			description: result.reason,
		});
	}
	return result.ok;
}
