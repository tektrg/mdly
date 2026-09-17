// @vitest-environment happy-dom
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView, type EditorViewProps } from "../ui/EditorView";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const STATUS_TABLE = [
	"| Task | Status |",
	"| --- | --- |",
	"| Write tests | Todo |",
	"| Fix bug | Doing |",
	"| Ship | Done |",
].join("\n");

/**
 * Slice 3 mounted behaviour: the chevron appears only behind the opt-in prop,
 * only when editable, only with the caret in a plain-text cell of a
 * qualifying column — and picking a value writes it to the document.
 * Everything else about the slice (thresholds, blanks, same-value no-op,
 * whole-cell replace) is proven headlessly in `inferredSelect.test.ts`.
 */
describe("TableValuePicker mounting (O11, R29, R33, R45)", () => {
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
			initialMarkdown: `${STATUS_TABLE}\n`,
			onLocalChange: vi.fn(),
			onSave: vi.fn(),
			onOpenExternalLink: vi.fn(),
			onOpenWikiLink: vi.fn(),
			tableInteractivity: true,
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

	function caretIntoCellText() {
		const live = editor;
		if (!live) throw new Error("Editor was never ready");
		let textPos = -1;
		live.state.doc.descendants((node, pos) => {
			if (textPos < 0 && node.type.name === "text" && node.text === "Doing") {
				textPos = pos;
			}
			return textPos < 0;
		});
		if (textPos < 0) throw new Error("Cell text not found");
		act(() => {
			live.view.dispatch(
				live.state.tr.setSelection(
					TextSelection.near(live.state.doc.resolve(textPos)),
				),
			);
		});
	}

	async function flushFrames(times = 3) {
		for (let index = 0; index < times; index += 1) {
			// eslint-disable-next-line no-await-in-loop
			await act(async () => {
				await new Promise((resolve) => requestAnimationFrame(resolve));
			});
		}
	}

	it("shows the chevron with the caret in a qualifying plain-text cell", async () => {
		mount();
		caretIntoCellText();
		await flushFrames();
		const chevron = container.querySelector("[data-table-value-chevron]");
		expect(chevron).not.toBeNull();
		act(() => {
			(chevron as HTMLButtonElement).click();
		});
		const options = Array.from(
			container.querySelectorAll("[data-table-value-menu] [role='option']"),
		).map((option) => option.textContent);
		expect(options).toEqual(["Todo", "Doing", "Done"]);
	});

	it("mounts nothing without the opt-in prop (R33)", async () => {
		mount({ tableInteractivity: undefined });
		caretIntoCellText();
		await flushFrames();
		expect(container.querySelector("[data-table-value-picker]")).toBeNull();
		expect(container.querySelector("[data-table-value-chevron]")).toBeNull();
	});

	it("mounts nothing on a read-only surface (R45)", async () => {
		mount({ editable: false });
		await flushFrames();
		expect(container.querySelector("[data-table-value-picker]")).toBeNull();
	});

	it("picking a value writes it into the focused cell", async () => {
		const props = mount();
		caretIntoCellText();
		await flushFrames();
		const chevron = container.querySelector<HTMLButtonElement>(
			"[data-table-value-chevron]",
		);
		if (!chevron) throw new Error("Chevron never appeared");
		act(() => {
			chevron.click();
		});
		const done = Array.from(
			container.querySelectorAll<HTMLButtonElement>(
				"[data-table-value-menu] [role='option']",
			),
		).find((option) => option.textContent === "Done");
		if (!done) throw new Error("Done option missing");
		act(() => {
			done.click();
		});
		await flushFrames();
		expect(props.onLocalChange).toHaveBeenCalled();
		const live = editor;
		if (!live) throw new Error("Editor was never ready");
		let found = false;
		live.state.doc.descendants((node) => {
			if (node.type.name === "tableCell" && node.textContent === "Done") {
				found = true;
				return false;
			}
			return true;
		});
		expect(found).toBe(true);
	});
});
