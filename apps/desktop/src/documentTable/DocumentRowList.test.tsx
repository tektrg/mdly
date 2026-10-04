// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceStore } from "../store/state";
import { type DocumentRowDensity, DocumentRowList } from "./DocumentRowList";
import type { DocumentTableRow } from "./documentTableView";
import {
	buildRows,
	manyMarkdownFiles,
	viewWith,
	WORKSPACE_FILES,
} from "./testFixtures";

// The seam `closeDocumentToTable` calls to hand focus back. Mocked so the test
// can invoke the registered callback directly, without standing up the store.
const registeredCloseFocus: { current: (() => void) | null } = {
	current: null,
};
vi.mock("../store/closeDocument", () => ({
	registerDocumentCloseFocus: (takeFocus: () => void) => {
		registeredCloseFocus.current = takeFocus;
		return () => {
			registeredCloseFocus.current = null;
		};
	},
}));

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Above `useVirtualSidebarRows`' 120-row threshold, so only a window of rows is
// ever in the DOM. Both defects below are invisible on a short list: the
// existing keyboard test uses three rows, which is why neither was caught.
const VIRTUALIZED_FILES = manyMarkdownFiles(200);

const NEWEST_FIRST = viewWith();
const BY_NAME = viewWith({ sort: { column: "name", direction: "asc" } });

describe("DocumentRowList virtualized behaviour", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function renderRows(
		rows: DocumentTableRow[],
		density: DocumentRowDensity = "table",
	) {
		act(() => {
			root.render(
				<DocumentRowList
					rows={rows}
					density={density}
					onOpenDocument={vi.fn()}
					emptyState={<p>No documents</p>}
				/>,
			);
		});
	}

	function scrollContainer(): HTMLElement {
		const el = container.querySelector<HTMLElement>('[role="rowgroup"]');
		if (!el) throw new Error("scroll container not rendered");
		return el;
	}

	function renderedRows(): HTMLElement[] {
		return Array.from(
			container.querySelectorAll<HTMLElement>("[data-document-row-index]"),
		);
	}

	function scrollTo(scrollTop: number) {
		act(() => {
			const el = scrollContainer();
			el.scrollTop = scrollTop;
			el.dispatchEvent(new Event("scroll"));
		});
	}

	describe("H4 — the open document's row is brought into view", () => {
		it("scrolls to the active row when a document is opened off-screen", () => {
			// `/ws/note-0000.md` is the oldest file, so newest-first puts it last.
			renderRows(
				buildRows({
					files: VIRTUALIZED_FILES,
					view: NEWEST_FIRST,
					activePath: "/ws/note-0000.md",
				}),
			);

			expect(scrollContainer().scrollTop).toBeGreaterThan(0);
		});

		it("scrolls again when the open document changes", () => {
			renderRows(
				buildRows({
					files: VIRTUALIZED_FILES,
					view: NEWEST_FIRST,
					activePath: "/ws/note-0000.md",
				}),
			);
			scrollTo(0);

			renderRows(
				buildRows({
					files: VIRTUALIZED_FILES,
					view: NEWEST_FIRST,
					activePath: "/ws/note-0010.md",
				}),
			);

			expect(scrollContainer().scrollTop).toBeGreaterThan(0);
		});

		it("never scrolls on a live re-sort that leaves the same document open", () => {
			// R4's whole point: rows may reorder under a reading user, and the
			// surface must not yank the viewport when they do.
			renderRows(
				buildRows({
					files: VIRTUALIZED_FILES,
					view: NEWEST_FIRST,
					activePath: "/ws/note-0000.md",
				}),
			);
			scrollTo(1_000);

			// Same open document, brand-new index (last row becomes the first).
			renderRows(
				buildRows({
					files: VIRTUALIZED_FILES,
					view: BY_NAME,
					activePath: "/ws/note-0000.md",
				}),
			);

			expect(scrollContainer().scrollTop).toBe(1_000);
		});

		it("never scrolls while the filter narrows the list under the same document", () => {
			renderRows(
				buildRows({
					files: VIRTUALIZED_FILES,
					view: NEWEST_FIRST,
					activePath: "/ws/note-0000.md",
				}),
			);
			scrollTo(1_000);

			renderRows(
				buildRows({
					files: VIRTUALIZED_FILES,
					view: viewWith({ filter: "note-00" }),
					activePath: "/ws/note-0000.md",
				}),
			);

			expect(scrollContainer().scrollTop).toBe(1_000);
		});
	});

	describe("M4 — exactly one rendered row is always tabbable", () => {
		it("keeps a tabbable row after the list is scrolled past index 0", () => {
			renderRows(buildRows({ files: VIRTUALIZED_FILES, view: NEWEST_FIRST }));
			scrollTo(4_000);

			const rendered = renderedRows();
			expect(rendered.length).toBeGreaterThan(0);
			// Row 0 is far above the virtual window, so a fallback of "index 0"
			// leaves nothing in the tab order and Tab skips the whole list.
			expect(rendered.map((row) => row.dataset.documentRowIndex)).not.toContain(
				"0",
			);
			expect(rendered.filter((row) => row.tabIndex === 0)).toHaveLength(1);
		});

		it("keeps exactly one tabbable row at the top of the list", () => {
			renderRows(buildRows({ files: VIRTUALIZED_FILES, view: NEWEST_FIRST }));

			expect(renderedRows().filter((row) => row.tabIndex === 0)).toHaveLength(
				1,
			);
		});

		it("prefers the active row when it is rendered", () => {
			renderRows(
				buildRows({
					files: VIRTUALIZED_FILES,
					view: NEWEST_FIRST,
					activePath: "/ws/note-0199.md",
				}),
			);

			const tabbable = renderedRows().filter((row) => row.tabIndex === 0);
			expect(tabbable).toHaveLength(1);
			expect(tabbable[0]?.getAttribute("aria-current")).toBe("true");
		});
	});
});

describe("DocumentRowList title-column menu", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function renderList({
		menu = true,
		pinned = [],
	}: {
		menu?: boolean;
		pinned?: string[];
	} = {}) {
		const onOpenDocument = vi.fn();
		const handlers = {
			onRevealPath: vi.fn(),
			onCopyPath: vi.fn(),
			onMovePath: vi.fn(),
			onTogglePin: vi.fn(),
			onDeletePath: vi.fn(),
		};
		const pinnedSet = new Set(pinned);
		act(() => {
			root.render(
				<DocumentRowList
					rows={buildRows()}
					density="table"
					onOpenDocument={onOpenDocument}
					emptyState={<p>No documents</p>}
					menu={
						menu
							? {
									...handlers,
									isPinned: (path: string) => pinnedSet.has(path),
									revealLabel: "Reveal in Finder",
								}
							: undefined
					}
				/>,
			);
		});
		return { onOpenDocument, handlers };
	}

	function menuTriggers(): HTMLElement[] {
		return Array.from(
			container.querySelectorAll<HTMLElement>(
				'button[aria-label^="Actions for"]',
			),
		);
	}

	function openMenuItems(): HTMLElement[] {
		return Array.from(
			document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
		);
	}

	function menuText(): string {
		return openMenuItems()
			.map((el) => el.textContent ?? "")
			.join("\n");
	}

	it("renders one ... trigger per row only when the menu is provided", () => {
		renderList({ menu: false });
		expect(menuTriggers()).toHaveLength(0);

		renderList({ menu: true });
		// Three markdown fixtures; the .html/.png never become rows.
		expect(menuTriggers()).toHaveLength(3);
	});

	it("opens the sidebar's items on right-click, without Rename", () => {
		renderList();
		const row = container.querySelector<HTMLElement>(
			"[data-document-row-index]",
		);
		if (!row) throw new Error("no row rendered");
		act(() => {
			row.dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
			);
		});

		expect(openMenuItems()).toHaveLength(5);
		const text = menuText();
		for (const label of [
			"Reveal in Finder",
			"Copy file path",
			"Move to...",
			"Pin",
			"Delete",
		]) {
			expect(text).toContain(label);
		}
		expect(text).not.toContain("Rename");
	});

	it("opens the same menu from the ... trigger", () => {
		renderList();
		const trigger = menuTriggers()[0];
		if (!trigger) throw new Error("no menu trigger rendered");
		act(() => {
			trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(openMenuItems()).toHaveLength(5);
		expect(menuText()).toContain("Copy file path");
	});

	it("labels the pin item from workspace pin state", () => {
		// Newest-first puts /ws/alpha.md first.
		renderList({ pinned: ["/ws/alpha.md"] });
		const row = container.querySelector<HTMLElement>(
			"[data-document-row-index]",
		);
		if (!row) throw new Error("no row rendered");
		act(() => {
			row.dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
			);
		});

		expect(menuText()).toContain("Unpin");
		expect(menuText()).not.toContain("\nPin\n");
	});

	it("routes menu clicks to the row's path and keeps left-click opening", () => {
		const { onOpenDocument, handlers } = renderList();
		const row = container.querySelector<HTMLElement>(
			"[data-document-row-index]",
		);
		if (!row) throw new Error("no row rendered");
		act(() => {
			row.dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
			);
		});

		const deleteItem = openMenuItems().find((el) =>
			(el.textContent ?? "").includes("Delete"),
		);
		if (!deleteItem) throw new Error("Delete item not rendered");
		act(() => {
			deleteItem.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(handlers.onDeletePath).toHaveBeenCalledTimes(1);
		expect(handlers.onDeletePath).toHaveBeenCalledWith("/ws/alpha.md");
		expect(onOpenDocument).not.toHaveBeenCalled();

		act(() => {
			row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(onOpenDocument).toHaveBeenCalledTimes(1);
		expect(onOpenDocument).toHaveBeenCalledWith(
			expect.objectContaining({ path: "/ws/alpha.md" }),
		);
	});
});

describe("DocumentRowList close-focus seam", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	// Closing a document used to leave focus on `<body>`, so Tab restarted from
	// the top of the window rather than continuing in the list now on screen.
	it("takes focus on the tabbable row after a document closes", () => {
		act(() => {
			root.render(
				<DocumentRowList
					rows={buildRows({ files: manyMarkdownFiles(200) })}
					density="table"
					onOpenDocument={vi.fn()}
					emptyState={<p>No documents</p>}
				/>,
			);
		});
		expect(document.activeElement).toBe(document.body);

		// The real seam fires while the *narrow* list is still mounted, so the
		// callback defers a frame; run that frame synchronously.
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			cb(0);
			return 0;
		});
		act(() => registeredCloseFocus.current?.());

		const focused = document.activeElement as HTMLElement | null;
		expect(focused?.getAttribute("data-document-row-index")).not.toBeNull();
		expect(focused?.getAttribute("tabindex")).toBe("0");
	});
});

describe("DocumentRowList open-document reveal in grouped views", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function renderRows(rows: DocumentTableRow[]) {
		act(() => {
			root.render(
				<DocumentRowList
					rows={rows}
					density="table"
					view={viewWith({ groupBy: "folder" })}
					onOpenDocument={vi.fn()}
					emptyState={<p>No documents</p>}
				/>,
			);
		});
	}

	// A document opened from the command palette can live inside a group the
	// user collapsed: its row is not rendered at all, so there is nothing to
	// highlight or scroll to until the group reopens around it.
	it("expands the collapsed group holding the open document and scrolls to it", () => {
		const previous = workspaceStore.get();
		workspaceStore.set((state) => ({
			...state,
			workspacePath: "/ws",
			navExpandedGroups: { "/ws": [] },
		}));
		try {
			renderRows(
				buildRows({
					files: WORKSPACE_FILES,
					view: viewWith({ groupBy: "folder" }),
					activePath: "/ws/notes/deep/gamma.md",
				}),
			);

			expect(container.textContent).toContain("gamma");
			const activeRowEl = container.querySelector<HTMLElement>(
				'[aria-current="true"]',
			);
			expect(activeRowEl?.textContent).toContain("gamma");
			const scroller =
				container.querySelector<HTMLElement>('[role="rowgroup"]');
			expect(scroller?.scrollTop).toBeGreaterThan(0);
			const expanded = workspaceStore.get().navExpandedGroups["/ws"] ?? [];
			expect(expanded).toContain("notes");
			expect(expanded).toContain("notes/deep");
			// The user's other collapses are untouched — only the open file's
			// own chain reopens.
			expect([...expanded].sort()).toEqual(["notes", "notes/deep"]);
		} finally {
			workspaceStore.set(() => previous);
		}
	});
});
