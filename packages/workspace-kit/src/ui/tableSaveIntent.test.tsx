// @vitest-environment happy-dom
import type { Editor } from "@tiptap/core";
import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tableTransformTransaction } from "../tables/applyTableTransform.js";
import { moveTableColumn } from "../tables/tableTransforms.js";
import { EditorView, type EditorViewProps } from "./EditorView";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TABLE_MARKDOWN = ["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n");

/**
 * PRE-1 (charter R12 / ruling R-H). The editor only writes the file when the
 * user interacted within `USER_EDIT_INTENT_WINDOW_MS`. A freshly mounted editor
 * has *no* recent interaction — the same state a drag that outlasts the window
 * leaves behind — so a table transform committed here must still reach the save
 * path purely on the strength of the transaction's own user-edit flag.
 *
 * Without the `onUpdate` wiring in `EditorView`, every case below sees zero
 * calls: the transform changes the screen and silently loses the file write.
 */
describe("table transforms re-mark save intent (PRE-1, R12)", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let editor: Editor | null = null;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		editor = null;
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function mount(overrides: Partial<EditorViewProps> = {}) {
		const props: EditorViewProps = {
			path: "/workspace/table.md",
			initialMarkdown: `${TABLE_MARKDOWN}\n`,
			saveDebounceMs: 0,
			onLocalChange: vi.fn(),
			onSave: vi.fn(),
			onOpenExternalLink: vi.fn(),
			onOpenWikiLink: vi.fn(),
			onEditorReady: (ready: Editor | null) => {
				editor = ready;
			},
			...overrides,
		};
		act(() => {
			root.render(<EditorView {...props} />);
		});
		return props;
	}

	function commitColumnMove(live: Editor) {
		const tablePos = firstTablePosition(live);
		const transaction = tableTransformTransaction(
			live.state,
			tablePos,
			(table) => moveTableColumn(table, 0, 1),
		);
		if (!transaction) throw new Error("Expected the column move to commit");
		act(() => {
			live.view.dispatch(transaction);
		});
	}

	it("publishes the transformed markdown with no preceding keystroke", () => {
		const props = mount();
		const live = editor;
		if (!live) throw new Error("Editor was never ready");

		commitColumnMove(live);

		expect(props.onLocalChange).toHaveBeenCalledTimes(1);
		expect(props.onLocalChange).toHaveBeenCalledWith(
			"/workspace/table.md",
			expect.stringContaining("| B | A |"),
		);
	});

	it("still refuses to publish an edit that carries no user intent", () => {
		const props = mount();
		const live = editor;
		if (!live) throw new Error("Editor was never ready");

		// Same shape of document change, but dispatched without the flag: the
		// 1-second intent window is untouched, so this must stay unsaved.
		act(() => {
			live.view.dispatch(live.state.tr.insertText("x", 1));
		});

		expect(props.onLocalChange).not.toHaveBeenCalled();
	});
});

function firstTablePosition(live: Editor): number {
	let found = -1;
	live.state.doc.descendants((node, pos) => {
		if (found < 0 && node.type.name === "table") found = pos;
		return found < 0;
	});
	if (found < 0) throw new Error("No table in the mounted document");
	return found;
}
