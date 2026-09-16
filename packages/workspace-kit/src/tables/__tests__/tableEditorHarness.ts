import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
	markdownToTiptapDoc,
	notionBlockExtensions,
	tableExtensions,
	tiptapDocToMarkdown,
	toggleBlockExtensions,
} from "../../engine/index.js";
import { tableTransformTransaction } from "../applyTableTransform.js";
import type { TableTransform } from "../tableTransforms.js";

/**
 * Test-only bridge: real Markdown in, a real ProseMirror document built from
 * the app's own schema, and real Markdown back out. Nothing here is mocked, so
 * a case that passes proves the bytes a save would write.
 */
const liveEditors: Editor[] = [];

export function destroyHarnessEditors(): void {
	for (const editor of liveEditors) editor.destroy();
	liveEditors.length = 0;
}

export function editorFromMarkdown(markdown: string): Editor {
	const editor = new Editor({
		element: document.createElement("div"),
		extensions: [
			// `trailingNode` is on in the real editor; it appends a cosmetic empty
			// paragraph that would show up as trailing blank lines in every
			// expected-Markdown string here without telling us anything about the
			// transforms. Off, so a case asserts exactly the table's own bytes.
			StarterKit.configure({ trailingNode: false }),
			...tableExtensions,
			...toggleBlockExtensions,
			...notionBlockExtensions,
		],
		content: markdownToTiptapDoc(markdown),
	});
	liveEditors.push(editor);
	return editor;
}

export function markdownOf(editor: Editor): string {
	return tiptapDocToMarkdown(editor.getJSON());
}

/** Document position of the nth table node (0-based), or -1 when absent. */
export function tablePosition(editor: Editor, tableIndex = 0): number {
	let seen = 0;
	let found = -1;
	editor.state.doc.descendants((node, pos) => {
		if (node.type.name !== "table") return true;
		if (seen === tableIndex && found < 0) found = pos;
		seen += 1;
		// Keep descending: a table can be nested inside another table's cell.
		return true;
	});
	return found;
}

export type CommittedTransform = {
	/** True when a transaction was actually dispatched (R8's tell). */
	committed: boolean;
	/** Markdown after the gesture — the bytes an ordinary save would write. */
	markdown: string;
};

/**
 * Run one table gesture end to end the way the UI stage will: build a single
 * transaction, dispatch it only when something changed, and read the file bytes
 * back.
 */
export function commitTransform(
	editor: Editor,
	transform: TableTransform,
	tableIndex = 0,
): CommittedTransform {
	const pos = tablePosition(editor, tableIndex);
	const transaction =
		pos < 0 ? null : tableTransformTransaction(editor.state, pos, transform);
	if (transaction) editor.view.dispatch(transaction);
	return { committed: transaction !== null, markdown: markdownOf(editor) };
}

/** Markdown for `input` with no gesture applied — the untouched baseline. */
export function roundTripMarkdown(markdown: string): string {
	return tiptapDocToMarkdown(markdownToTiptapDoc(markdown));
}
