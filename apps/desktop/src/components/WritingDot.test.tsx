// @vitest-environment happy-dom
import type { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WritingDot } from "./WritingDot";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
	listWritingTools: vi.fn(),
	prewarmWritingEngine: vi.fn(),
	runWritingTool: vi.fn(),
	resetWritingTool: vi.fn(),
	cancelWritingTool: vi.fn(),
}));
vi.mock("../desktopApi", () => ({ desktopApi: api }));
vi.mock("../store/actions", () => ({ loadPath: vi.fn() }));

/** Just enough of a TipTap editor for the dot: a non-empty selection. */
function fakeEditor() {
	const toggleLinkAtSelection = vi.fn(() => true);
	const editor = {
		isEditable: true,
		state: {
			selection: { from: 1, to: 6, empty: false },
			doc: { textBetween: () => "Hello" },
		},
		view: { coordsAtPos: () => ({ right: 10, top: 10 }) },
		on: (event: string, fn: () => void) => {
			if (event === "selectionUpdate") editor.select = fn;
		},
		select: () => {},
		off: vi.fn(),
		commands: { toggleLinkAtSelection },
	};
	return { editor: editor as unknown as Editor, toggleLinkAtSelection };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
	api.listWritingTools.mockResolvedValue([
		{
			id: "proofread",
			name: "Proofread",
			engine: "apple",
			prompt: "p",
			builtIn: true,
			filePath: "/t/proofread.md",
		},
	]);
	api.prewarmWritingEngine.mockResolvedValue({ state: "ready" });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

async function openDot(props: { onComment?: (() => void) | null }) {
	const { editor, toggleLinkAtSelection } = fakeEditor();
	await act(async () => {
		root.render(
			<WritingDot
				editor={editor}
				path="/w/n.md"
				hasWatcher={false}
				{...props}
			/>,
		);
	});
	await act(async () => (editor as unknown as { select: () => void }).select());
	await act(async () => {
		container
			.querySelector<HTMLButtonElement>('button[aria-label="Writing tools"]')
			?.click();
	});
	return { toggleLinkAtSelection };
}

describe("WritingDot", () => {
	it("prewarms Apple's model when the editor opens", async () => {
		await openDot({});
		expect(api.prewarmWritingEngine).toHaveBeenCalled();
	});

	it("holds Comment · Link · divider · tools, in that order", async () => {
		await openDot({ onComment: vi.fn() });
		const menu = container.querySelector('[role="menu"]');
		const items = Array.from(menu?.children ?? []).map((el) =>
			el.tagName === "HR" ? "|" : (el.textContent ?? "").replace(/✎|↺/g, ""),
		);
		expect(items).toEqual(["Comment", "Link⌘K", "|", "Proofreadapple"]);
	});

	it("Comment and Link run their actions", async () => {
		const onComment = vi.fn();
		const { toggleLinkAtSelection } = await openDot({ onComment });
		const button = (label: string) =>
			Array.from(
				container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
			).find((b) => b.textContent?.startsWith(label));
		await act(async () => button("Comment")?.click());
		expect(onComment).toHaveBeenCalledTimes(1);
		await act(async () => {
			container
				.querySelector<HTMLButtonElement>('button[aria-label="Writing tools"]')
				?.click();
		});
		await act(async () => button("Link")?.click());
		expect(toggleLinkAtSelection).toHaveBeenCalledTimes(1);
	});

	it("without comments (e.g. a draft is open) Comment is not offered", async () => {
		await openDot({ onComment: null });
		expect(container.textContent).not.toContain("Comment");
		expect(container.textContent).toContain("Link");
	});
});
