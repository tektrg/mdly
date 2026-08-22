// @vitest-environment happy-dom
import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView, type EditorViewProps } from "./EditorView";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * R18 regression guard: `onOpenRevisionHistory` (Slice 3) is an opt-in prop,
 * same convention as `onIdleOrForcedCut` (Slice 1). `apps/www` and
 * `apps/notion-web` never pass it, so this proves that omitting it leaves
 * EditorView's pre-existing external-content-reload behavior (the
 * `initialMarkdown`-changed effect) completely unchanged, and renders no new
 * UI either.
 */
describe("EditorView external-content reload, prop omitted (R18)", () => {
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

	function baseProps(
		overrides: Partial<EditorViewProps> = {},
	): EditorViewProps {
		return {
			path: "/workspace/note.md",
			initialMarkdown: "Hello world\n",
			onLocalChange: vi.fn(),
			onSave: vi.fn(),
			onOpenExternalLink: vi.fn(),
			onOpenWikiLink: vi.fn(),
			...overrides,
		};
	}

	it("still silently swaps in new initialMarkdown content with no new UI rendered", () => {
		const props = baseProps();
		act(() => {
			root.render(<EditorView {...props} />);
		});

		expect(container.textContent).toContain("Hello world");
		expect(
			container.querySelector("[data-revision-history-trigger]"),
		).toBeNull();

		act(() => {
			root.render(
				<EditorView {...props} initialMarkdown="Changed outside\n" />,
			);
		});

		expect(container.textContent).toContain("Changed outside");
		expect(container.textContent).not.toContain("Hello world");
		expect(
			container.querySelector("[data-revision-history-trigger]"),
		).toBeNull();
	});

	it("renders the history affordance only when onOpenRevisionHistory is provided", () => {
		const onOpenRevisionHistory = vi.fn();
		act(() => {
			root.render(
				<EditorView
					{...baseProps()}
					onOpenRevisionHistory={onOpenRevisionHistory}
				/>,
			);
		});

		const trigger = container.querySelector<HTMLButtonElement>(
			"[data-revision-history-trigger]",
		);
		expect(trigger).not.toBeNull();
		act(() => trigger?.click());
		expect(onOpenRevisionHistory).toHaveBeenCalledWith("/workspace/note.md");
	});
});
