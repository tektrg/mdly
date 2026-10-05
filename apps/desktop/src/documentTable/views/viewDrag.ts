import type { FrontMatterEditValue } from "@mdly/workspace-kit/engine";
import { type DragEvent, useState } from "react";
import { toast } from "sonner";
import type { DocumentTableRow } from "../documentTableView";
import { READ_ONLY_MOVE_MESSAGE } from "../properties/builtinFields";
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
 * already in the file. A refusal is shown, never swallowed. A built-in
 * (read-only) field writes nothing and says why.
 */
export async function writeDroppedProperty(
	row: DocumentTableRow,
	field: PropertyField,
	value: FrontMatterEditValue | null,
): Promise<boolean> {
	if (field.readOnly) {
		toast.error(READ_ONLY_MOVE_MESSAGE);
		return false;
	}
	const result = await writeDocumentProperty(row, field.label, value);
	if (!result.ok) {
		toast.error(`“${row.name}” was not changed`, {
			description: result.reason,
		});
	}
	return result.ok;
}

/**
 * Drop-zone state + handlers. `dragleave` also fires when the pointer moves
 * onto a child (a card), so leaving is only counted when the pointer really
 * left the zone — otherwise the highlight flickers while dragging over cards.
 */
export function useNoteDropTarget(onDropPath: (path: string) => void) {
	const [isDropTarget, setIsDropTarget] = useState(false);
	return {
		isDropTarget,
		dropHandlers: {
			onDragOver: (event: DragEvent<HTMLElement>) => {
				if (!isNoteDrag(event)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "move";
				if (!isDropTarget) setIsDropTarget(true);
			},
			onDragLeave: (event: DragEvent<HTMLElement>) => {
				const next = event.relatedTarget as Node | null;
				if (next && event.currentTarget.contains(next)) return;
				setIsDropTarget(false);
			},
			onDrop: (event: DragEvent<HTMLElement>) => {
				event.preventDefault();
				setIsDropTarget(false);
				const path = draggedNotePath(event);
				if (path) onDropPath(path);
			},
		},
	};
}

/** The "Move to" menu of a card on a read-only field: one disabled line saying why. */
export const READ_ONLY_MOVE_TARGETS = [
	{ key: "read-only", label: READ_ONLY_MOVE_MESSAGE, disabled: true },
] as const;
