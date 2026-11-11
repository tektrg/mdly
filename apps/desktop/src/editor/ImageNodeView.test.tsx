// @vitest-environment happy-dom
import type { NodeViewProps } from "@tiptap/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../desktopApi", () => ({ desktopApi: { platform: "darwin" } }));

const { ImageNodeView } = await import("./ImageNodeView");

let container: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
});
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	container.remove();
	document.body.innerHTML = "";
});

function renderImage() {
	const setNodeSelection = vi.fn();
	const props = {
		node: { attrs: { src: "https://example.com/a.png", alt: "a" } },
		filePath: "/docs/note.md",
		selected: false,
		updateAttributes: vi.fn(),
		getPos: () => 1,
		editor: {
			isEditable: true,
			commands: { setNodeSelection },
			state: { doc: { resolve: () => ({ depth: 0 }) } },
		},
	} as unknown as NodeViewProps & { filePath: string };
	act(() => {
		root = createRoot(container);
		root.render(<ImageNodeView {...props} />);
	});
	return { setNodeSelection };
}

describe("ImageNodeView click behavior", () => {
	it("single click does not open the full-screen viewer", async () => {
		const { setNodeSelection } = renderImage();
		const img = container.querySelector("img");
		expect(img).not.toBeNull();
		expect(img?.getAttribute("title")).toBeNull();
		await act(async () => {
			img?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(setNodeSelection).not.toHaveBeenCalled();
		expect(document.querySelector(".pm-image-viewer-img")).toBeNull();
	});

	it("right-click menu offers View full screen, Copy path", async () => {
		renderImage();
		const img = container.querySelector("img");
		await act(async () => {
			img?.dispatchEvent(
				new MouseEvent("contextmenu", {
					bubbles: true,
					clientX: 10,
					clientY: 10,
				}),
			);
		});
		const text = document.body.textContent ?? "";
		expect(text).toContain("View full screen");
		expect(text).toContain("Copy path");
	});
});
