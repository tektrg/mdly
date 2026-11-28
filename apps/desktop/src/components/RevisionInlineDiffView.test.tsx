// @vitest-environment happy-dom
import { markdownToTiptapDoc } from "@mdly/workspace-kit";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { act, type ReactNode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryRevision } from "../desktopApi/types";
import { SuggestionExtension } from "../editor/SuggestionExtension";
import { RevisionInlineDiffView } from "./RevisionInlineDiffView";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const createdEditors: Editor[] = [];

vi.mock("@hubble.md/ui", () => ({
	Button: ({
		children,
		onClick,
		title,
	}: {
		children: ReactNode;
		onClick?: () => void;
		title?: string;
	}) => (
		<button type="button" title={title} onClick={onClick}>
			{children}
		</button>
	),
}));

vi.mock("../desktopApi", () => ({
	desktopApi: { openExternalUrl: vi.fn() },
}));

vi.mock("../editor/ImageExtension", () => ({
	createImageExtension: () => [],
}));

vi.mock("../editor/EmbedExtension", () => ({
	createEmbedExtension: () => [],
}));

vi.mock("@mdly/workspace-kit", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@mdly/workspace-kit")>();
	return {
		...actual,
		DiffChangeRail: () => <div data-testid="diff-rail" />,
		DiffGroupsView: ({
			groups,
		}: {
			groups: { id: string; kind: string }[];
		}) => (
			<div data-testid="raw-diff-groups" data-count={String(groups.length)} />
		),
		EditorView: ({
			initialMarkdown,
			editable,
			onEditorReady,
		}: {
			initialMarkdown: string;
			editable?: boolean;
			onEditorReady?: (editor: Editor | null) => void;
		}) => {
			useEffect(() => {
				const el = document.createElement("div");
				document.body.append(el);
				const parsed = actual.parseMarkdownFrontMatter(initialMarkdown);
				const editor = new Editor({
					element: el,
					editable: editable ?? true,
					extensions: [StarterKit, SuggestionExtension],
					content: markdownToTiptapDoc(parsed.body),
				});
				createdEditors.push(editor);
				onEditorReady?.(editor);
				return () => {
					onEditorReady?.(null);
					editor.destroy();
					el.remove();
				};
			}, [initialMarkdown, editable, onEditorReady]);
			return <div data-testid="rich-editor-view" />;
		},
	};
});

const SAMPLE_REVISION: HistoryRevision = {
	id: "rev-1",
	hash: "abc",
	at: Date.parse("2026-11-28T00:00:00.000Z"),
	by: { kind: "agent", id: "claude" },
	cause: "external-write",
	bytes: 42,
	prev: null,
};

describe("RevisionInlineDiffView", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		for (const e of createdEditors) e.destroy();
		createdEditors.length = 0;
		container.remove();
	});

	function findButton(label: string) {
		return [...container.querySelectorAll("button")].find(
			(el) => el.textContent === label,
		);
	}

	it("renders rich inline diff by default and toggles to raw diff without re-fetching", async () => {
		const onReadRevisionContent = vi.fn().mockResolvedValue({
			status: "ok",
			content: "The quick brown fox.",
		});
		const onBack = vi.fn();

		await act(async () => {
			root.render(
				<RevisionInlineDiffView
					path="/ws/note.md"
					revision={SAMPLE_REVISION}
					currentContent="The slow brown fox."
					onReadRevisionContent={onReadRevisionContent}
					onBack={onBack}
				/>,
			);
		});

		expect(
			container.querySelector('[data-revision-diff-mode="rich"]'),
		).not.toBeNull();
		expect(container.textContent).toContain("1/1 change");
		expect(createdEditors[0]?.isEditable).toBe(false);
		expect(createdEditors[0]?.view.dom.innerHTML).toContain("mdly-sugg-del");
		expect(createdEditors[0]?.view.dom.innerHTML).toContain("mdly-sugg-ins");

		// Toggle to Raw diff
		act(() => findButton("Raw diff")?.click());
		expect(
			container.querySelector('[data-testid="raw-diff-groups"]'),
		).not.toBeNull();
		expect(onReadRevisionContent).toHaveBeenCalledTimes(1);

		// Toggle back to Rich diff
		act(() => findButton("Rich diff")?.click());
		expect(
			container.querySelector('[data-revision-diff-mode="rich"]'),
		).not.toBeNull();
		expect(onReadRevisionContent).toHaveBeenCalledTimes(1);

		// Back to editor
		act(() => findButton("Back to editor")?.click());
		expect(onBack).toHaveBeenCalledTimes(1);
	});

	it("shows a frontmatter-only banner with quick switch to raw diff", async () => {
		const onReadRevisionContent = vi.fn().mockResolvedValue({
			status: "ok",
			content: "---\ntitle: Old\n---\n\nSame body.",
		});

		await act(async () => {
			root.render(
				<RevisionInlineDiffView
					path="/ws/note.md"
					revision={SAMPLE_REVISION}
					currentContent={"---\ntitle: New\n---\n\nSame body."}
					onReadRevisionContent={onReadRevisionContent}
					onBack={vi.fn()}
				/>,
			);
		});

		expect(container.textContent).toContain(
			"Only frontmatter changed since this revision.",
		);
		act(() => findButton("View raw diff")?.click());
		expect(
			container.querySelector('[data-testid="raw-diff-groups"]'),
		).not.toBeNull();
	});

	it("surfaces unavailable revision content cleanly", async () => {
		const onReadRevisionContent = vi.fn().mockResolvedValue({
			status: "unavailable",
		});

		await act(async () => {
			root.render(
				<RevisionInlineDiffView
					path="/ws/note.md"
					revision={SAMPLE_REVISION}
					currentContent="Live content."
					onReadRevisionContent={onReadRevisionContent}
					onBack={vi.fn()}
				/>,
			);
		});

		expect(
			container.querySelector("[data-revision-unavailable]"),
		).not.toBeNull();
	});
});
