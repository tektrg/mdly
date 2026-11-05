/**
 * Board side effects: moving a card (front-matter rewrite with Undo),
 * creating a note preset to a column, duplicating a note. The pure value
 * math lives in `boardModel.ts`; this file only sequences writes and toasts.
 */
import {
	type FrontMatterEditValue,
	setFrontMatterValue,
} from "@mdly/workspace-kit/engine";
import { toast } from "sonner";
import { desktopApi } from "../../desktopApi";
import { basename, dirname } from "../../lib/filePath";
import {
	createMarkdownFileInFolder,
	refreshFiles,
	uniqueMarkdownPath,
} from "../../store/actions";
import { workspaceStore } from "../../store/state";
import type { DocumentTableRow } from "../documentTableView";
import { READ_ONLY_MOVE_MESSAGE } from "../properties/builtinFields";
import type { PropertyField } from "../properties/propertyFields";
import {
	type PropertyWriteResult,
	writeDocumentProperty,
} from "../properties/propertyWrite";
import { type BoardColumn, movedBoardValue, rawBoardValue } from "./boardModel";

type WriteProperty = (
	row: DocumentTableRow,
	key: string,
	value: FrontMatterEditValue | null,
) => Promise<PropertyWriteResult>;

type Notify = {
	moved: (message: string, undo: () => void) => void;
	failed: (message: string, reason: string) => void;
};

const defaultNotify: Notify = {
	moved: (message, undo) =>
		toast(message, { action: { label: "Undo", onClick: undo } }),
	failed: (message, reason) => toast.error(message, { description: reason }),
};

export type BoardMove = {
	row: DocumentTableRow;
	title: string;
	field: PropertyField;
	from: Pick<BoardColumn, "kind" | "value">;
	to: Pick<BoardColumn, "kind" | "value" | "label">;
};

/**
 * Writes the moved value of the board field; on success offers Undo, which
 * writes the card's previous value back (same key, same queue). Returns
 * false when nothing was written (refusal shown, never swallowed).
 */
export async function moveBoardCard(
	move: BoardMove,
	write: WriteProperty = writeDocumentProperty,
	notify: Notify = defaultNotify,
): Promise<boolean> {
	const { row, field, title } = move;
	if (field.readOnly) {
		notify.failed(`“${title}” was not moved`, READ_ONLY_MOVE_MESSAGE);
		return false;
	}
	const previous = rawBoardValue(row, field.id);
	const next = movedBoardValue(row, field.id, move.from, move.to);
	const result = await write(row, field.label, next);
	if (!result.ok) {
		notify.failed(`“${title}” was not changed`, result.reason);
		return false;
	}
	if (!result.changed) return true;
	notify.moved(`Moved “${title}” to ${move.to.label}`, () => {
		void write(row, field.label, previous).then((undone) => {
			if (!undone.ok)
				notify.failed(`“${title}” was not restored`, undone.reason);
		});
	});
	return true;
}

/** A new note in the workspace root whose board field is `column`'s value; opens it. */
export async function createNoteInColumn(
	field: PropertyField,
	column: Pick<BoardColumn, "value">,
): Promise<void> {
	const root = workspaceStore.get().workspacePath;
	if (!root) return;
	let content = "";
	if (column.value !== null && !field.readOnly) {
		const edit = setFrontMatterValue("", field.label, column.value);
		if (!edit.ok) {
			toast.error("The note was not created", { description: edit.reason });
			return;
		}
		content = `${edit.text}\n`;
	}
	await createMarkdownFileInFolder(root, { content });
}

/** "<name> copy.md" next to the original, same bytes. */
export async function duplicateNote(row: DocumentTableRow): Promise<void> {
	const parent = dirname(row.openPath);
	if (!parent) return;
	try {
		const text = await desktopApi.readFileText(row.openPath);
		const stem = basename(row.openPath).replace(/\.[^.]+$/, "");
		const target = uniqueMarkdownPath(parent, `${stem} copy`);
		await desktopApi.writeFileText(target, text);
		await refreshFiles();
		toast.success(`Duplicated as ${basename(target)}`);
	} catch (error) {
		toast.error("The note was not duplicated", { description: String(error) });
	}
}
