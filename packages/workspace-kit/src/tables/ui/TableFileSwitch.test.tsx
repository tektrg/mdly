// @vitest-environment happy-dom
import type { Editor } from "@tiptap/core";
import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView, type EditorViewProps } from "../../ui/EditorView";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TABLE_MD = ["| A | B |", "| --- | --- |", "| 1 | 2 |", ""].join("\n");

describe("table discovery across file switches", () => {
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

	function mount(initialMarkdown: string) {
		const props: EditorViewProps = {
			path: "/workspace/table.md",
			initialMarkdown,
			saveDebounceMs: 0,
			onLocalChange: vi.fn(),
			onSave: vi.fn(),
			onOpenExternalLink: vi.fn(),
			onOpenWikiLink: vi.fn(),
			onEditorReady: (ready: Editor | null) => {
				editor = ready;
			},
			tableInteractivity: true,
		};
		act(() => {
			root.render(<EditorView {...props} />);
		});
		if (!editor) throw new Error("Editor was never ready");
		return { props, live: editor as Editor };
	}

	it("discovers the table after a file-switch setContent", async () => {
		const { props } = mount("Hello world\n");
		expect(container.querySelectorAll("[data-table-overlay]").length).toBe(0);
		act(() => {
			root.render(<EditorView {...props} initialMarkdown={`${TABLE_MD}\n`} />);
		});
		await act(async () => {
			await new Promise((resolve) => window.setTimeout(resolve, 100));
		});
		expect(container.querySelector(".tableWrapper table")).not.toBeNull();
		expect(container.querySelectorAll("[data-table-overlay]").length).toBe(1);
	});

	it("discovers the table after undo restores the doc shape", async () => {
		const { live } = mount(`${TABLE_MD}\n`);
		await act(async () => {
			await new Promise((resolve) => window.setTimeout(resolve, 100));
		});
		expect(container.querySelectorAll("[data-table-overlay]").length).toBe(1);
		// Insert above the table (shifts its pos), then undo (restores pos).
		act(() => {
			(live as Editor)
				.chain()
				.focus()
				.setTextSelection(1)
				.insertContent("x")
				.run();
		});
		await act(async () => {
			await new Promise((resolve) => window.setTimeout(resolve, 100));
		});
		act(() => {
			(live as Editor).commands.undo();
		});
		await act(async () => {
			await new Promise((resolve) => window.setTimeout(resolve, 100));
		});
		expect(container.querySelector(".tableWrapper table")).not.toBeNull();
		expect(container.querySelectorAll("[data-table-overlay]").length).toBe(1);
	});
});
