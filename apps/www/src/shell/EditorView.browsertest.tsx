// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorView } from "./EditorView";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * R31: apps/www's own EditorView wrapper wires the shared kit's `editable`
 * prop to `false`, and read-only must not degrade rendering — a note with a
 * link, an image, and bold/italic still has to render correctly.
 */
describe("apps/www EditorView is read-only (R31)", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	// An absolute image URL sidesteps this wrapper's asset-download-URL
	// resolution path (which needs a backend ctx) — this test is about
	// markdown-to-DOM rendering fidelity in read-only mode, not asset
	// resolution, which is exercised elsewhere.
	const MARKDOWN = [
		"# Title",
		"",
		"A paragraph with a [link](https://example.com), **bold** text, and *italic* text.",
		"",
		"![a photo](https://example.com/pic.png)",
		"",
	].join("\n");

	it("renders a link, image, bold, and italic, and the ProseMirror surface itself is non-editable", () => {
		act(() => {
			root.render(
				<EditorView path="/workspace/note.md" initialMarkdown={MARKDOWN} />,
			);
		});

		// Links render as `<span data-href="…" data-link="true">`, not a native
		// `<a>` — see the shared kit's `engine/Link.ts` `renderHTML` (clicks are
		// intercepted by `LinkClickExtension` instead of native navigation).
		const link = container.querySelector<HTMLElement>(
			"[data-link='true'][data-href='https://example.com']",
		);
		expect(link).not.toBeNull();
		expect(link?.textContent).toBe("link");

		expect(container.querySelector("strong")?.textContent).toBe("bold");
		expect(container.querySelector("em")?.textContent).toBe("italic");

		const img = container.querySelector("img");
		expect(img).not.toBeNull();
		expect(img?.getAttribute("src")).toBe("https://example.com/pic.png");

		const pmRoot = container.querySelector("[contenteditable]");
		expect(pmRoot).not.toBeNull();
		expect(pmRoot?.getAttribute("contenteditable")).toBe("false");
	});

	it("rejects a simulated keyboard edit — content is unchanged after a keydown on the editable surface", () => {
		act(() => {
			root.render(
				<EditorView
					path="/workspace/note.md"
					initialMarkdown="Hello world\n"
				/>,
			);
		});
		const before = container.textContent;
		const pmRoot = container.querySelector<HTMLElement>("[contenteditable]");
		expect(pmRoot).not.toBeNull();

		act(() => {
			pmRoot?.dispatchEvent(
				new InputEvent("beforeinput", {
					bubbles: true,
					cancelable: true,
					inputType: "insertText",
					data: "X",
				}),
			);
		});

		expect(container.textContent).toBe(before);
	});
});
